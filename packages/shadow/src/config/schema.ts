import { z } from "zod";
import { BudgetSchema, ModelAliasSchema as AgentModelAliasSchema, StageNameSchema } from "../orchestration/types.js";

export const ProviderModelSchema = z.object({
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  inputCostPerMillionTokens: z.number().nonnegative().default(0),
  outputCostPerMillionTokens: z.number().nonnegative().default(0),
  /**
   * Reporting/budget metadata only. Stages choose model aliases directly; this flag says
   * whether usage from the alias should count against the reserved high-capability pool.
   */
  reservedBudget: z.boolean().default(false),
  /** Legacy spelling accepted for existing configs and reports. */
  frontier: z.boolean().optional()
});

export const LegacyModelAliasSchema = ProviderModelSchema.extend({
  provider: z.string().min(1)
});

export const ProviderSchema = z.object({
  kind: z.enum(["openai-compatible", "openai", "anthropic", "google", "mock"]).default("openai-compatible"),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  models: z.record(z.string().min(1), ProviderModelSchema).default({}),
  structuredOutput: z.boolean().default(true),
  // Newer OpenAI models require max_completion_tokens; set false for servers that
  // only accept the older max_tokens parameter.
  maxCompletionTokensParam: z.boolean().default(true),
  // Every model request is abandoned after this long. Without it a stalled
  // connection held a benchmark run open indefinitely at zero CPU.
  requestTimeoutMs: z.number().int().positive().default(120_000)
});

const AgentModelMappingSchema = z.object({
  chat: AgentModelAliasSchema,
  plan: AgentModelAliasSchema,
  design: AgentModelAliasSchema,
  develop: AgentModelAliasSchema,
  test: AgentModelAliasSchema,
  validate: AgentModelAliasSchema,
  deploy: AgentModelAliasSchema,
  document: AgentModelAliasSchema
});

export const ApprovalPolicySchema = z.object({
  allowWorkspaceWrites: z.boolean().default(true),
  requireApprovalForDestructive: z.boolean().default(true),
  requireApprovalForExternalWrites: z.boolean().default(true),
  requireApprovalForNetwork: z.boolean().default(false),
  requireApprovalForDeploy: z.boolean().default(true)
});

export const DeploymentProfileSchema = z.object({
  environment: z.string().min(1),
  deployCommand: z.array(z.string()).min(1),
  healthCheckCommand: z.array(z.string()).min(1),
  rollbackCommand: z.array(z.string()).min(1).optional(),
  credentialEnv: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .default([])
});
export type DeploymentProfile = z.infer<typeof DeploymentProfileSchema>;

const defaultApprovalPolicy: z.infer<typeof ApprovalPolicySchema> = {
  allowWorkspaceWrites: true,
  requireApprovalForDestructive: true,
  requireApprovalForExternalWrites: true,
  requireApprovalForNetwork: false,
  requireApprovalForDeploy: true
};

const ShadowConfigBaseSchema = z.object({
  version: z.literal(1).default(1),
  providers: z.record(z.string(), ProviderSchema).default({}),
  /**
   * Legacy flat alias table. New configs should define aliases under
   * `providers.<provider>.models`; the loader still accepts this shape so existing
   * repositories continue to run.
   */
  models: z.record(z.string().min(1), LegacyModelAliasSchema).default({}),
  agents: AgentModelMappingSchema,
  budgets: z.object({
    run: BudgetSchema,
    stage: BudgetSchema,
    modelCall: BudgetSchema
  }),
  lifecycle: z.object({
    enabledStages: z.array(StageNameSchema).default([
      "plan",
      "design",
      "develop",
      "test",
      "validate",
      "deploy",
      "document"
    ]),
    maxStageRetries: z.number().int().nonnegative().default(1),
    maxModelCallsPerStage: z.number().int().positive().default(3),
    maxRemediationCycles: z.number().int().nonnegative().default(1)
  }),
  workspace: z.object({
    exclusions: z.array(z.string().min(1)).default([])
  }),
  deployment: z.object({
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), DeploymentProfileSchema).default({})
  }).default({ profiles: {} }),
  approvals: ApprovalPolicySchema.default(defaultApprovalPolicy),
  persistence: z.object({
    databasePath: z.string().default(".shadow/shadow.db"),
    runsDir: z.string().default(".shadow/runs"),
    artifactsDir: z.string().default(".shadow/artifacts")
  }),
  mcp: z.object({
    tests: z.object({
      enabled: z.boolean().default(true),
      command: z.array(z.string().min(1)).min(1).optional(),
      startupTimeoutMs: z.number().int().positive().default(5_000),
      pollIntervalMs: z.number().int().positive().default(100)
    })
  }),
  telemetry: z.object({
    localOnly: z.boolean().default(true),
    remoteEnabled: z.boolean().default(false)
  })
});

export const ShadowConfigSchema = ShadowConfigBaseSchema.superRefine((config, context) => {
  const aliases = new Map<string, string>();
  const modelIds = new Map<string, string[]>();
  const recordModelId = (modelId: string, path: string) => {
    const existing = modelIds.get(modelId) ?? [];
    existing.push(path);
    modelIds.set(modelId, existing);
  };
  for (const [alias, model] of Object.entries(config.models)) {
    aliases.set(alias, `models.${alias}`);
    recordModelId(model.model, `models.${alias}`);
    if (!config.providers[model.provider]) {
      context.addIssue({
        code: "custom",
        path: ["models", alias, "provider"],
        message: `model alias ${alias} references unknown provider ${model.provider}`
      });
    }
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const [alias, model] of Object.entries(provider.models)) {
      const existing = aliases.get(alias);
      if (existing) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerId, "models", alias],
          message: `model alias ${alias} is already defined at ${existing}`
        });
      } else {
        aliases.set(alias, `providers.${providerId}.models.${alias}`);
      }
      recordModelId(model.model, `providers.${providerId}.models.${alias}`);
    }
  }
  for (const [stage, alias] of Object.entries(config.agents)) {
    if (aliases.has(alias)) {
      continue;
    }
    const modelIdMatches = modelIds.get(alias) ?? [];
    if (modelIdMatches.length === 1) {
      continue;
    }
    if (modelIdMatches.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["agents", stage],
        message:
          `stage ${stage} references model id ${alias}, which is configured under multiple aliases: ` +
          modelIdMatches.join(", ")
      });
    } else {
      context.addIssue({
        code: "custom",
        path: ["agents", stage],
        message: `stage ${stage} references unknown model alias ${alias}`
      });
    }
  }
});

export type ShadowConfig = z.infer<typeof ShadowConfigSchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type LegacyModelAlias = z.infer<typeof LegacyModelAliasSchema>;

export interface ResolvedModelAlias extends Omit<ProviderModel, "frontier"> {
  alias: string;
  provider: string;
  frontier: boolean;
}

export function resolveModelAlias(
  config: ShadowConfig,
  alias: string
): ResolvedModelAlias | undefined {
  const legacy = config.models[alias];
  if (legacy) {
    return {
      ...legacy,
      alias,
      frontier: (legacy.frontier ?? legacy.reservedBudget) || alias === "frontier"
    };
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const model = provider.models[alias];
    if (model) {
      return {
        ...model,
        alias,
        provider: providerId,
        frontier: model.frontier ?? model.reservedBudget
      };
    }
  }
  let match: ResolvedModelAlias | undefined;
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const [configuredAlias, model] of Object.entries(provider.models)) {
      if (model.model !== alias) {
        continue;
      }
      const resolved = {
        ...model,
        alias: configuredAlias,
        provider: providerId,
        frontier: model.frontier ?? model.reservedBudget
      };
      if (match) {
        return undefined;
      }
      match = resolved;
    }
  }
  if (match) {
    return match;
  }
  return undefined;
}

export function listModelAliases(config: ShadowConfig): ResolvedModelAlias[] {
  const aliases = Object.keys(config.models)
    .map((alias) => resolveModelAlias(config, alias))
    .filter((alias): alias is ResolvedModelAlias => Boolean(alias));
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const [alias, model] of Object.entries(provider.models)) {
      aliases.push({
        ...model,
        alias,
        provider: providerId,
        frontier: model.frontier ?? model.reservedBudget
      });
    }
  }
  return aliases.sort((left, right) => left.alias.localeCompare(right.alias));
}

export function selectFrontierModelAlias(config: ShadowConfig): ResolvedModelAlias {
  const aliases = listModelAliases(config);
  const frontier = aliases.find((alias) => alias.frontier);
  const fallback = frontier ?? aliases[0];
  if (!fallback) {
    throw new Error("No model aliases are configured.");
  }
  return fallback;
}

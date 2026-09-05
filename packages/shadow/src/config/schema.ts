import { z } from "zod";
import { BudgetSchema, CapabilityTierSchema, StageNameSchema } from "../orchestration/types.js";

export const ModelAliasSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  inputCostPerMillionTokens: z.number().nonnegative().default(0),
  outputCostPerMillionTokens: z.number().nonnegative().default(0)
});

export const ProviderSchema = z.object({
  kind: z.enum(["openai-compatible", "mock"]).default("openai-compatible"),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  structuredOutput: z.boolean().default(true)
});

const AgentModelMappingSchema = z.record(StageNameSchema, CapabilityTierSchema);

export const ApprovalPolicySchema = z.object({
  allowWorkspaceWrites: z.boolean().default(true),
  requireApprovalForDestructive: z.boolean().default(true),
  requireApprovalForExternalWrites: z.boolean().default(true),
  requireApprovalForNetwork: z.boolean().default(false),
  requireApprovalForDeploy: z.boolean().default(true)
});

const defaultApprovalPolicy: z.infer<typeof ApprovalPolicySchema> = {
  allowWorkspaceWrites: true,
  requireApprovalForDestructive: true,
  requireApprovalForExternalWrites: true,
  requireApprovalForNetwork: false,
  requireApprovalForDeploy: true
};

export const ShadowConfigSchema = z.object({
  version: z.literal(1).default(1),
  providers: z.record(z.string(), ProviderSchema).default({}),
  models: z.record(CapabilityTierSchema, ModelAliasSchema),
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
    maxModelCallsPerStage: z.number().int().positive().default(3)
  }),
  workspace: z.object({
    exclusions: z.array(z.string().min(1)).default([])
  }),
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

export type ShadowConfig = z.infer<typeof ShadowConfigSchema>;

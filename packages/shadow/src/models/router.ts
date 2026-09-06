import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ShadowConfig } from "../config/schema.js";
import { checkBudget } from "../orchestration/budget.js";
import type {
  Budget,
  CapabilityTier,
  ModelCallRecord,
  UsageTotals
} from "../orchestration/types.js";
import { evaluatePolicy } from "../policies/policy.js";
import type { ModelProvider, ModelRequest } from "./provider.js";
import { Utf8TokenEstimator, type TokenEstimator } from "./token-estimator.js";

const zeroUsage: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0
};

export interface StructuredModelCall<T> {
  tier: CapabilityTier;
  system: string;
  input: unknown;
  schemaName: string;
  schema: z.ZodType<T>;
  stageBudget: Budget;
  stageUsage: UsageTotals;
  runBudget: Budget;
  runUsage: UsageTotals;
  approved?: boolean;
  signal?: AbortSignal;
}

export interface StructuredModelResult<T> {
  output: T;
  record: ModelCallRecord;
}

/**
 * A Zod failure's `message` is a JSON dump of every issue. Surfacing it raw put a
 * multi-line array where a stage summary belongs; this reduces it to one sentence naming
 * the fields that were wrong.
 */
export function describeSchemaFailure(schemaName: string, error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const more = error.issues.length > 5 ? ` (+${error.issues.length - 5} more)` : "";
  return `Model response did not match ${schemaName}: ${issues}${more}`;
}

export class ModelRoutingError extends Error {
  constructor(message: string, readonly record: ModelCallRecord) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class ModelRouter {
  constructor(
    private readonly config: ShadowConfig,
    private readonly providers: ReadonlyMap<string, ModelProvider>,
    private readonly estimator: TokenEstimator = new Utf8TokenEstimator()
  ) {}

  async completeStructured<T>(call: StructuredModelCall<T>): Promise<StructuredModelResult<T>> {
    const startedAt = performance.now();
    const alias = this.config.models[call.tier];
    const provider = this.providers.get(alias.provider);
    const serializedInput = JSON.stringify(call.input);
    const estimatedInputTokens = this.estimator.estimate(call.system) + this.estimator.estimate(serializedInput);
    const requestedOutputTokens = Math.min(
      alias.maxOutputTokens,
      this.config.budgets.modelCall.maxOutputTokens
    );
    const planned: UsageTotals = {
      inputTokens: estimatedInputTokens,
      outputTokens: requestedOutputTokens,
      estimatedCostUsd:
        (estimatedInputTokens * alias.inputCostPerMillionTokens +
          requestedOutputTokens * alias.outputCostPerMillionTokens) /
        1_000_000
    };
    const baseRecord = {
      id: randomUUID(),
      tier: call.tier,
      provider: alias.provider,
      model: alias.model,
      estimatedInputTokens,
      requestedOutputTokens,
      approvalRequired: false
    };

    if (call.signal?.aborted) {
      const reason = "Model call cancelled.";
      throw new ModelRoutingError(reason, {
        ...baseRecord,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        usage: zeroUsage,
        reason
      });
    }

    const policy = evaluatePolicy(
      {
        id: "model.complete",
        description: "Send bounded context to a configured model provider.",
        risk: "read_only",
        writesWorkspace: false,
        writesOutsideWorkspace: false,
        usesNetwork: true,
        deploys: false,
        touchesSecrets: false
      },
      this.config
    );
    if (!policy.allowed || (policy.requiresApproval && !call.approved)) {
      const reason = policy.reasons.join("; ") || "Model call requires approval.";
      throw new ModelRoutingError(reason, {
        ...baseRecord,
        status: "blocked",
        approvalRequired: policy.requiresApproval,
        durationMs: Math.round(performance.now() - startedAt),
        usage: zeroUsage,
        reason
      });
    }

    const reasons = [
      ...checkBudget(this.config.budgets.modelCall, zeroUsage, planned, call.tier).reasons,
      ...checkBudget(call.stageBudget, call.stageUsage, planned, call.tier).reasons,
      ...checkBudget(call.runBudget, call.runUsage, planned, call.tier).reasons
    ];
    if (reasons.length > 0) {
      const reason = [...new Set(reasons)].join("; ");
      throw new ModelRoutingError(reason, {
        ...baseRecord,
        status: "blocked",
        durationMs: Math.round(performance.now() - startedAt),
        usage: zeroUsage,
        reason
      });
    }
    if (!provider) {
      const reason = `Provider ${alias.provider} is not configured or its credentials are unavailable.`;
      throw new ModelRoutingError(reason, {
        ...baseRecord,
        status: "blocked",
        durationMs: Math.round(performance.now() - startedAt),
        usage: zeroUsage,
        reason
      });
    }

    const request: ModelRequest = {
      tier: call.tier,
      model: alias.model,
      system: call.system,
      input: call.input,
      maxOutputTokens: requestedOutputTokens,
      ...(call.signal ? { signal: call.signal } : {}),
      outputSchema: {
        name: call.schemaName,
        schema: z.toJSONSchema(call.schema) as Record<string, unknown>
      }
    };

    let responseUsage = zeroUsage;
    try {
      const response = await provider.complete(request);
      responseUsage = {
        ...response.usage,
        estimatedCostUsd: response.usage.estimatedCostUsd ||
          (response.usage.inputTokens * alias.inputCostPerMillionTokens +
            response.usage.outputTokens * alias.outputCostPerMillionTokens) /
            1_000_000
      };
      const output = call.schema.parse(JSON.parse(response.text));
      return {
        output,
        record: {
          ...baseRecord,
          status: "completed",
          durationMs: Math.round(performance.now() - startedAt),
          usage: responseUsage
        }
      };
    } catch (error) {
      const reason = describeSchemaFailure(call.schemaName, error);
      throw new ModelRoutingError(reason, {
        ...baseRecord,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        usage: responseUsage,
        reason
      });
    }
  }
}

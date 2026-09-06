import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/models/provider.js";
import type { StageName } from "../../src/orchestration/types.js";

/** Schema name the model-backed Plan stage asks for. */
export const planSchemaName = "shadow_plan_result_v1";

export function isPlanRequest(request: ModelRequest): boolean {
  return request.outputSchema?.name === planSchemaName;
}

export interface PlanResponseOptions {
  stages?: StageName[];
  tasks?: Array<{
    stage: StageName;
    goal?: string;
    acceptanceCriteria?: string[];
    recommendedTier?: "frontier" | "balanced" | "economy" | "unspecified";
  }>;
  unknowns?: string[];
  risks?: string[];
  usage?: ModelResponse["usage"];
}

/** A well-formed Plan result. Defaults reproduce the ordinary edit graph. */
export function planResponse(options: PlanResponseOptions = {}): ModelResponse {
  const stages = options.stages ?? (["develop", "test", "validate"] as StageName[]);
  return {
    text: JSON.stringify({
      summary: "Planned the requested change.",
      complexity: "low",
      stages,
      tasks: options.tasks ?? [],
      unknowns: options.unknowns ?? [],
      risks: options.risks ?? [],
      approvalsRequired: []
    }),
    usage: options.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  };
}

/**
 * Wraps a provider that only knows how to answer the stage under test, so the Plan stage's
 * call is answered separately and does not show up in that stage's call counts or usage.
 */
export function withPlanStage(
  provider: ModelProvider,
  options: PlanResponseOptions = {}
): ModelProvider {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (isPlanRequest(request)) {
        return planResponse(options);
      }
      return provider.complete(request);
    }
  };
}

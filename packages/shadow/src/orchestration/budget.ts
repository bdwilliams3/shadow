import type { Budget, UsageTotals } from "./types.js";

export interface BudgetDecision {
  allowed: boolean;
  reasons: string[];
}

export function totalTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens;
}

export function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd
  };
}

export function checkBudget(
  budget: Budget,
  current: UsageTotals,
  planned: UsageTotals,
  frontierModel: boolean
): BudgetDecision {
  const next = addUsage(current, planned);
  const reasons: string[] = [];

  if (next.inputTokens > budget.maxInputTokens) {
    reasons.push(`input token budget exceeded: ${next.inputTokens}/${budget.maxInputTokens}`);
  }
  if (next.outputTokens > budget.maxOutputTokens) {
    reasons.push(`output token budget exceeded: ${next.outputTokens}/${budget.maxOutputTokens}`);
  }
  if (totalTokens(next) > budget.maxTotalTokens) {
    reasons.push(`total token budget exceeded: ${totalTokens(next)}/${budget.maxTotalTokens}`);
  }
  if (next.estimatedCostUsd > budget.maxEstimatedCostUsd) {
    reasons.push(
      `estimated cost budget exceeded: ${next.estimatedCostUsd.toFixed(4)}/${budget.maxEstimatedCostUsd}`
    );
  }
  if (
    !frontierModel &&
    budget.reservedFrontierTokens > 0 &&
    totalTokens(next) > budget.maxTotalTokens - budget.reservedFrontierTokens
  ) {
    reasons.push(
      `call would consume reserved frontier tokens: ${totalTokens(next)}/${budget.maxTotalTokens - budget.reservedFrontierTokens}`
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons
  };
}

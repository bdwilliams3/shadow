import { describe, expect, it } from "vitest";
import { checkBudget } from "../src/orchestration/budget.js";
import type { Budget, UsageTotals } from "../src/orchestration/types.js";

const budget: Budget = {
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxTotalTokens: 120,
  maxEstimatedCostUsd: 1,
  reservedFrontierTokens: 20
};

const none: UsageTotals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

describe("checkBudget", () => {
  it("allows planned usage inside limits", () => {
    const result = checkBudget(
      budget,
      none,
      { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.1 },
      false
    );

    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects over-budget calls", () => {
    const result = checkBudget(
      budget,
      none,
      { inputTokens: 110, outputTokens: 5, estimatedCostUsd: 0.1 },
      false
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("input token budget exceeded");
  });

  it("protects reserved frontier tokens from non-frontier calls", () => {
    const result = checkBudget(
      budget,
      none,
      { inputTokens: 90, outputTokens: 15, estimatedCostUsd: 0.1 },
      false
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("call would consume reserved frontier tokens: 105/100");
  });

  it("allows frontier calls to use the reserved capacity", () => {
    const result = checkBudget(
      budget,
      none,
      { inputTokens: 90, outputTokens: 15, estimatedCostUsd: 0.1 },
      true
    );

    expect(result.allowed).toBe(true);
  });
});

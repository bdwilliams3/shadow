import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider, ModelRequest } from "../src/models/provider.js";
import { ModelRouter, ModelRoutingError } from "../src/models/router.js";
import type { UsageTotals } from "../src/orchestration/types.js";

const ResultSchema = z.object({ answer: z.string() });
const noUsage: UsageTotals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

function callOptions() {
  return {
    tier: defaultConfig.agents.develop,
    system: "Return JSON.",
    input: { question: "hello" },
    schemaName: "fixture_result_v1",
    schema: ResultSchema,
    stageBudget: defaultConfig.budgets.stage,
    stageUsage: noUsage,
    runBudget: defaultConfig.budgets.run,
    runUsage: noUsage
  };
}

describe("ModelRouter", () => {
  it("routes a schema-constrained call and records actual usage", async () => {
    let request: ModelRequest | undefined;
    const provider: ModelProvider = {
      async complete(value) {
        request = value;
        return {
          text: JSON.stringify({ answer: "world" }),
          usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.01 }
        };
      }
    };
    const router = new ModelRouter(defaultConfig, new Map([["anthropic", provider], ["google", provider], ["openai", provider]]));

    const result = await router.completeStructured(callOptions());

    expect(result.output).toEqual({ answer: "world" });
    expect(result.record.status).toBe("completed");
    expect(result.record.usage.inputTokens).toBe(12);
    expect(request?.outputSchema?.name).toBe("fixture_result_v1");
  });

  it("blocks an over-budget call before invoking the provider", async () => {
    const complete = vi.fn<ModelProvider["complete"]>();
    const router = new ModelRouter(defaultConfig, new Map([["anthropic", { complete }], ["google", { complete }], ["openai", { complete }]]), {
      estimate: () => 30_000
    });

    await expect(router.completeStructured(callOptions())).rejects.toSatisfy(
      (error: unknown) => error instanceof ModelRoutingError && error.record.status === "blocked"
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects non-JSON provider output without string scraping", async () => {
    const provider: ModelProvider = {
      async complete() {
        return { text: "```json\n{\"answer\":\"world\"}\n```", usage: noUsage };
      }
    };
    const router = new ModelRouter(defaultConfig, new Map([["anthropic", provider], ["google", provider], ["openai", provider]]));

    await expect(router.completeStructured(callOptions())).rejects.toSatisfy(
      (error: unknown) => error instanceof ModelRoutingError && error.record.status === "failed"
    );
  });

  it("honors network approval policy before provider dispatch", async () => {
    const config = structuredClone(defaultConfig);
    config.approvals.requireApprovalForNetwork = true;
    const complete = vi.fn<ModelProvider["complete"]>();
    const router = new ModelRouter(config, new Map([["anthropic", { complete }], ["google", { complete }], ["openai", { complete }]]));

    await expect(router.completeStructured(callOptions())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelRoutingError &&
        error.record.status === "blocked" &&
        error.message.includes("network")
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { probeModels } from "../src/models/probe.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";

function configWith(models: Record<"primary" | "secondary" | "duplicate", string>) {
  const config = structuredClone(defaultConfig);
  config.providers = {
    test: {
      kind: "mock",
      models: {
        primary: {
          model: models.primary,
          maxOutputTokens: 100,
          inputCostPerMillionTokens: 0,
          outputCostPerMillionTokens: 0,
          reservedBudget: true
        },
        secondary: {
          model: models.secondary,
          maxOutputTokens: 100,
          inputCostPerMillionTokens: 0,
          outputCostPerMillionTokens: 0,
          reservedBudget: false
        },
        duplicate: {
          model: models.duplicate,
          maxOutputTokens: 100,
          inputCostPerMillionTokens: 0,
          outputCostPerMillionTokens: 0,
          reservedBudget: false
        }
      },
      structuredOutput: true,
      maxCompletionTokensParam: true,
      requestTimeoutMs: 120_000
    }
  };
  config.models = {};
  config.agents = {
    plan: "primary",
    design: "secondary",
    develop: "duplicate",
    test: "duplicate",
    validate: "secondary",
    deploy: "duplicate",
    document: "duplicate"
  };
  return config;
}

describe("doctor --probe", () => {
  it("reports the provider's own error for a model that is not reachable", async () => {
    const config = configWith({
      primary: "works",
      secondary: "wrong-endpoint",
      duplicate: "works"
    });
    const provider: ModelProvider = {
      async complete(request) {
        if (request.model === "wrong-endpoint") {
          throw new Error(
            "Model provider request failed with HTTP 404: This model is not supported in the v1/chat/completions endpoint."
          );
        }
        return { text: '{"ok":"ok"}', usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } };
      }
    };
    const lines: string[] = [];
    const ok = await probeModels(config, new Map([["test", provider]]), (line) => lines.push(line));

    expect(ok).toBe(false);
    expect(lines.some((line) => line.includes("wrong-endpoint") && line.includes("404"))).toBe(true);
    // Aliases sharing a reachable model are probed once and named together.
    expect(lines.some((line) => line.startsWith("duplicate, primary -> test/works: reachable"))).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("passes when every configured agent model answers", async () => {
    const config = configWith({ primary: "a", secondary: "b", duplicate: "c" });
    const calls: string[] = [];
    const provider: ModelProvider = {
      async complete(request) {
        calls.push(request.model);
        return { text: '{"ok":"ok"}', usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } };
      }
    };
    expect(await probeModels(config, new Map([["test", provider]]), () => {})).toBe(true);
    expect(calls.sort()).toEqual(["a", "b", "c"]);
  });
});

import { describe, expect, it } from "vitest";
import { probeModels } from "../src/models/probe.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { ModelProvider } from "../src/models/provider.js";

function configWith(models: Record<"frontier" | "balanced" | "economy", string>) {
  const config = structuredClone(defaultConfig);
  for (const tier of ["frontier", "balanced", "economy"] as const) {
    config.models[tier].model = models[tier];
  }
  return config;
}

describe("doctor --probe", () => {
  it("reports the provider's own error for a model that is not reachable", async () => {
    const config = configWith({
      frontier: "works",
      balanced: "wrong-endpoint",
      economy: "works"
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
    const ok = await probeModels(config, new Map([["default", provider]]), (line) => lines.push(line));

    expect(ok).toBe(false);
    expect(lines.some((line) => line.includes("wrong-endpoint") && line.includes("404"))).toBe(true);
    // Tiers sharing a reachable model are probed once and named together.
    expect(lines.some((line) => line.startsWith("frontier, economy -> default/works: reachable"))).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("passes when every configured tier model answers", async () => {
    const config = configWith({ frontier: "a", balanced: "b", economy: "c" });
    const calls: string[] = [];
    const provider: ModelProvider = {
      async complete(request) {
        calls.push(request.model);
        return { text: '{"ok":"ok"}', usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } };
      }
    };
    expect(await probeModels(config, new Map([["default", provider]]), () => {})).toBe(true);
    expect(calls.sort()).toEqual(["a", "b", "c"]);
  });
});

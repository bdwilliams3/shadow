import type { ShadowConfig } from "../config/schema.js";
import type { CapabilityTier } from "../orchestration/types.js";
import { createConfiguredProviders } from "./factory.js";
import type { ModelProvider } from "./provider.js";

/**
 * Sends one minimal request per distinct tier model, through the same transport the
 * agents use. A model id can be perfectly valid and still be unreachable — served on a
 * different endpoint, or not enabled for the key — and the only faithful way to find out
 * is to call it. Without this, a wrong tier entry surfaces as a failed benchmark run
 * several minutes and several tasks later.
 */
export async function probeModels(
  config: ShadowConfig,
  injected?: ReadonlyMap<string, ModelProvider>,
  log: (line: string) => void = console.log
): Promise<boolean> {
  let providers = injected;
  if (!providers) {
    const configured = createConfiguredProviders(config);
    for (const diagnostic of configured.diagnostics) {
      console.error(diagnostic);
    }
    providers = configured.providers;
  }
  const seen = new Map<string, string[]>();
  for (const tier of ["frontier", "balanced", "economy"] as const) {
    const alias = config.models[tier];
    const key = `${alias.provider}/${alias.model}`;
    seen.set(key, [...(seen.get(key) ?? []), tier]);
  }

  let allReachable = true;
  for (const [key, tiers] of seen) {
    const [providerId = "", model = ""] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
    const provider = providers.get(providerId);
    const label = `${tiers.join(", ")} -> ${key}`;
    if (!provider) {
      log(`${label}: provider not configured`);
      allReachable = false;
      continue;
    }
    try {
      await provider.complete({
        tier: tiers[0] as CapabilityTier,
        model,
        system: "Reply with {\"ok\":\"ok\"}.",
        input: {},
        maxOutputTokens: 16,
        outputSchema: {
          name: "shadow_probe_v1",
          schema: {
            type: "object",
            properties: { ok: { type: "string" } },
            required: ["ok"],
            additionalProperties: false
          }
        }
      });
      log(`${label}: reachable`);
    } catch (error) {
      log(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      allReachable = false;
    }
  }
  return allReachable;
}


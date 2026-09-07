import { listModelAliases, resolveModelAlias, type ShadowConfig } from "../config/schema.js";
import { createConfiguredProviders } from "./factory.js";
import type { ModelProvider } from "./provider.js";

/**
 * Sends one minimal request per distinct configured model, through the same transport the
 * agents use. A model id can be perfectly valid and still be unreachable — served on a
 * different endpoint, or not enabled for the key — and the only faithful way to find out
 * is to call it. Without this, a wrong alias surfaces as a failed run several minutes
 * and several stages later.
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
  const agentAliases = new Set(Object.values(config.agents));
  const seen = new Map<string, string[]>();
  for (const alias of listModelAliases(config).filter((candidate) => agentAliases.has(candidate.alias))) {
    const key = `${alias.provider}/${alias.model}`;
    seen.set(key, [...(seen.get(key) ?? []), alias.alias]);
  }

  let allReachable = true;
  for (const [key, aliases] of seen) {
    const firstAlias = aliases[0];
    if (!firstAlias) continue;
    const [providerId = "", model = ""] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
    const provider = providers.get(providerId);
    const label = `${aliases.join(", ")} -> ${key}`;
    if (!provider) {
      log(`${label}: provider not configured`);
      allReachable = false;
      continue;
    }
    try {
      await provider.complete({
        tier: resolveModelAlias(config, firstAlias)?.alias ?? firstAlias,
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

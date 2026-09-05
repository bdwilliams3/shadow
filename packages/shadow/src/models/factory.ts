import type { ShadowConfig } from "../config/schema.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./provider.js";

export interface ProviderFactoryResult {
  providers: Map<string, ModelProvider>;
  diagnostics: string[];
}

export function createConfiguredProviders(
  config: ShadowConfig,
  environment: NodeJS.ProcessEnv = process.env
): ProviderFactoryResult {
  const providers = new Map<string, ModelProvider>();
  const diagnostics: string[] = [];

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.kind === "mock") {
      diagnostics.push(`Provider ${id} uses the mock kind and must be injected by the caller.`);
      continue;
    }
    const environmentName = providerConfig.apiKeyEnv;
    const apiKey = environmentName ? environment[environmentName] : undefined;
    if (!apiKey) {
      diagnostics.push(`Provider ${id} is unavailable because ${environmentName ?? "an API key"} is not set.`);
      continue;
    }
    providers.set(
      id,
      new OpenAICompatibleProvider({
        baseUrl: providerConfig.baseUrl ?? "https://api.openai.com/v1",
        apiKey,
        structuredOutput: providerConfig.structuredOutput,
        maxCompletionTokensParam: providerConfig.maxCompletionTokensParam,
        requestTimeoutMs: providerConfig.requestTimeoutMs
      })
    );
  }

  return { providers, diagnostics };
}

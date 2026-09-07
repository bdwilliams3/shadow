import type { ShadowConfig } from "../config/schema.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
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
    if (providerConfig.kind === "anthropic") {
      providers.set(
        id,
        new AnthropicProvider({
          baseUrl: providerConfig.baseUrl ?? "https://api.anthropic.com/v1",
          apiKey,
          requestTimeoutMs: providerConfig.requestTimeoutMs
        })
      );
      continue;
    }
    if (providerConfig.kind === "google") {
      providers.set(
        id,
        new GoogleProvider({
          baseUrl: providerConfig.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
          apiKey,
          structuredOutput: providerConfig.structuredOutput,
          requestTimeoutMs: providerConfig.requestTimeoutMs
        })
      );
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

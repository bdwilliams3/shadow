import type { ModelAlias, UsageTotals } from "../orchestration/types.js";

export interface ModelRequest {
  tier: ModelAlias;
  model: string;
  system: string;
  input: unknown;
  maxOutputTokens: number;
  signal?: AbortSignal;
  outputSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ModelResponse {
  text: string;
  usage: UsageTotals;
  raw?: unknown;
}

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

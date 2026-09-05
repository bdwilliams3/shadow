import type { CapabilityTier, UsageTotals } from "../orchestration/types.js";

export interface ModelRequest {
  tier: CapabilityTier;
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

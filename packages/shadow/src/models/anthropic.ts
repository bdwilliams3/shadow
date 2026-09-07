import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
}

export class AnthropicProvider implements ModelProvider {
  constructor(private readonly options: AnthropicProviderOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const schemaInstruction = request.outputSchema
      ? `\nReturn only JSON matching this schema: ${JSON.stringify(request.outputSchema.schema)}`
      : "";

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: `${request.system}${schemaInstruction}`,
          messages: [{ role: "user", content: JSON.stringify(request.input) }]
        })
      });
    } catch (error) {
      if (deadline.aborted && !request.signal?.aborted) {
        throw new Error(`Model provider request exceeded ${timeoutMs}ms without a response.`);
      }
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Anthropic provider request failed with HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 600).replace(/\s+/g, " ").trim()}` : "")
      );
    }

    const raw = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = raw.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("") ?? "";

    return {
      text,
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        estimatedCostUsd: 0
      },
      raw
    };
  }
}

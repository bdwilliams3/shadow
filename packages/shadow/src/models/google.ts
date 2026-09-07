import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

export interface GoogleProviderOptions {
  baseUrl: string;
  apiKey: string;
  structuredOutput?: boolean;
  requestTimeoutMs?: number;
}

export class GoogleProvider implements ModelProvider {
  constructor(private readonly options: GoogleProviderOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const model = encodeURIComponent(request.model);
    const schemaInstruction = request.outputSchema && this.options.structuredOutput === false
      ? `\nReturn only JSON matching this schema: ${JSON.stringify(request.outputSchema.schema)}`
      : "";

    let response: Response;
    try {
      response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, "")}/models/${model}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: `${request.system}${schemaInstruction}` }]
            },
            contents: [
              {
                role: "user",
                parts: [{ text: JSON.stringify(request.input) }]
              }
            ],
            generationConfig: {
              maxOutputTokens: request.maxOutputTokens,
              ...(request.outputSchema && this.options.structuredOutput !== false
                ? {
                    responseMimeType: "application/json",
                    responseJsonSchema: request.outputSchema.schema
                  }
                : {})
            }
          })
        }
      );
    } catch (error) {
      if (deadline.aborted && !request.signal?.aborted) {
        throw new Error(`Model provider request exceeded ${timeoutMs}ms without a response.`);
      }
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Google provider request failed with HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 600).replace(/\s+/g, " ").trim()}` : "")
      );
    }

    const raw = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (raw.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      throw new Error(`Model output was truncated at the ${request.maxOutputTokens} token ceiling.`);
    }

    return {
      text: raw.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("") ?? "",
      usage: {
        inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0,
        estimatedCostUsd: 0
      },
      raw
    };
  }
}

import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  structuredOutput?: boolean;
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const schemaInstruction = request.outputSchema && this.options.structuredOutput === false
      ? `\nReturn only JSON matching this schema: ${JSON.stringify(request.outputSchema.schema)}`
      : "";
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      ...(request.signal ? { signal: request.signal } : {}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: `${request.system}${schemaInstruction}` },
          { role: "user", content: JSON.stringify(request.input) }
        ],
        max_tokens: request.maxOutputTokens,
        ...(request.outputSchema && this.options.structuredOutput !== false
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: request.outputSchema.name,
                  strict: true,
                  schema: request.outputSchema.schema
                }
              }
            }
          : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Model provider request failed with HTTP ${response.status}`);
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: raw.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0,
        estimatedCostUsd: 0
      },
      raw
    };
  }
}

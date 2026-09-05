import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  structuredOutput?: boolean;
  maxCompletionTokensParam?: boolean;
  requestTimeoutMs?: number;
}

/**
 * Keywords OpenAI's strict structured outputs rejects. Zod emits several of them from
 * ordinary constraints (`z.string().min(1)` becomes `minLength`), so they are stripped
 * before the schema is sent. The constraints still hold: the response is parsed back
 * through the original Zod schema, which is the real guard.
 */
const strictUnsupportedKeywords = new Set([
  "$schema",
  "default",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties"
]);

export function sanitizeStrictSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeStrictSchema);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !strictUnsupportedKeywords.has(key))
      .map(([key, entry]) => [key, sanitizeStrictSchema(entry)])
  );
}

/** Raised when the provider stopped at the output ceiling rather than finishing. */
export class ModelOutputTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputTruncatedError";
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const schemaInstruction = request.outputSchema && this.options.structuredOutput === false
      ? `\nReturn only JSON matching this schema: ${JSON.stringify(request.outputSchema.schema)}`
      : "";
    // The caller's signal handles cancellation; the deadline handles a connection that
    // simply never answers. A run must not be able to wait forever on a provider.
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
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
        // Newer OpenAI models reject max_tokens; older OpenAI-compatible servers only
        // accept it. The provider declares which one it speaks.
        ...(this.options.maxCompletionTokensParam === false
          ? { max_tokens: request.maxOutputTokens }
          : { max_completion_tokens: request.maxOutputTokens }),
        ...(request.outputSchema && this.options.structuredOutput !== false
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: request.outputSchema.name,
                  strict: true,
                  schema: sanitizeStrictSchema(request.outputSchema.schema)
                }
              }
            }
          : {})
      })
    });
    } catch (error) {
      if (deadline.aborted && !request.signal?.aborted) {
        throw new Error(`Model provider request exceeded ${timeoutMs}ms without a response.`);
      }
      throw error;
    }

    if (!response.ok) {
      // The provider's own explanation is the only useful part of a 4xx; without it a
      // misconfigured request is indistinguishable from an outage.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Model provider request failed with HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 600).replace(/\s+/g, " ").trim()}` : "")
      );
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // A response cut off at the output ceiling yields truncated JSON. Parsing it reports
    // a meaningless syntax error and invites an identical retry that burns the ceiling
    // again, so name the real cause and let the caller decline to repeat it.
    if (raw.choices?.[0]?.finish_reason === "length") {
      throw new ModelOutputTruncatedError(
        `Model output was truncated at the ${request.maxOutputTokens} token ceiling. ` +
          "Raise maxOutputTokens for this tier, or reduce the requested output."
      );
    }

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

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider, sanitizeStrictSchema } from "../src/models/openai-compatible.js";

interface StubResult {
  bodies: Record<string, unknown>[];
  url: string;
  close: () => Promise<void>;
}

let active: StubResult | undefined;

async function stubProvider(status: number, payload: unknown): Promise<StubResult> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const result: StubResult = {
    bodies,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
  active = result;
  return result;
}

afterEach(async () => {
  await active?.close();
  active = undefined;
});

const OutputSchema = z.object({
  summary: z.string().min(1),
  patch: z.string().min(1).max(500_000),
  decisions: z.array(z.string()).default([])
});

function requestFor(schema: boolean) {
  return {
    tier: "balanced" as const,
    model: "test-model",
    system: "system prompt",
    input: { request: "do the thing" },
    maxOutputTokens: 4_000,
    ...(schema
      ? {
          outputSchema: {
            name: "test_v1",
            schema: z.toJSONSchema(OutputSchema) as Record<string, unknown>
          }
        }
      : {})
  };
}

const okPayload = {
  choices: [{ message: { content: '{"summary":"s","patch":"p","decisions":[]}' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 }
};

describe("sanitizeStrictSchema", () => {
  it("removes the keywords strict structured outputs rejects", () => {
    const cleaned = sanitizeStrictSchema(z.toJSONSchema(OutputSchema)) as Record<string, unknown>;
    const serialized = JSON.stringify(cleaned);

    expect(serialized).not.toContain("minLength");
    expect(serialized).not.toContain("maxLength");
    expect(serialized).not.toContain("default");
    expect(serialized).not.toContain("$schema");
    // The parts strict mode requires must survive.
    expect(cleaned.additionalProperties).toBe(false);
    expect(cleaned.required).toEqual(["summary", "patch", "decisions"]);
    expect(Object.keys(cleaned.properties as object)).toEqual(["summary", "patch", "decisions"]);
  });

  it("leaves a schema without unsupported keywords unchanged", () => {
    const plain = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(sanitizeStrictSchema(plain)).toEqual(plain);
  });
});

describe("OpenAICompatibleProvider", () => {
  it("sends max_completion_tokens and a sanitized strict schema by default", async () => {
    const stub = await stubProvider(200, okPayload);
    const provider = new OpenAICompatibleProvider({ baseUrl: stub.url, apiKey: "test-key" });

    await provider.complete(requestFor(true));

    const body = stub.bodies[0]!;
    expect(body.max_completion_tokens).toBe(4_000);
    expect(body.max_tokens).toBeUndefined();
    expect(JSON.stringify(body.response_format)).not.toContain("minLength");
  });

  it("sends max_tokens when the provider declares the older parameter", async () => {
    const stub = await stubProvider(200, okPayload);
    const provider = new OpenAICompatibleProvider({
      baseUrl: stub.url,
      apiKey: "test-key",
      maxCompletionTokensParam: false
    });

    await provider.complete(requestFor(false));

    const body = stub.bodies[0]!;
    expect(body.max_tokens).toBe(4_000);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("surfaces the provider's error body instead of a bare status code", async () => {
    const stub = await stubProvider(400, {
      error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." }
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: stub.url, apiKey: "test-key" });

    await expect(provider.complete(requestFor(true))).rejects.toThrow(
      /HTTP 400.*Unsupported parameter/
    );
  });

  it("abandons a request the provider never answers", async () => {
    // A server that accepts the connection and then says nothing.
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      requestTimeoutMs: 300
    });

    try {
      await expect(provider.complete(requestFor(false))).rejects.toThrow(
        /exceeded 300ms without a response/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a truncated response as truncation rather than a JSON parse error", async () => {
    const stub = await stubProvider(200, {
      choices: [{ message: { content: '{"summary":"s","patch":"dif' }, finish_reason: "length" }],
      usage: { prompt_tokens: 523, completion_tokens: 4000 }
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: stub.url, apiKey: "test-key" });

    await expect(provider.complete(requestFor(true))).rejects.toThrow(
      /truncated at the 4000 token ceiling/
    );
  });
});

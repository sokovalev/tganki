import { describe, expect, it, vi } from "vitest";
import {
  createLimiter,
  type FetchLike,
  OpenRouterClient,
  OpenRouterError,
  parseContent,
  parseUsage,
  suggestModels,
} from "../scripts/llm-eval/openrouter.js";
import { CARD_JSON_SCHEMA } from "../scripts/llm-eval/prompt.js";

const CARD = {
  front: "der Tisch",
  back: "стол",
  transcription: "tɪʃ",
  example: "Das Buch liegt auf dem Tisch.",
  exampleTr: "Книга лежит на столе.",
  pos: "noun",
  detectedLang: "de",
};

function completion(content: unknown, cost = 0.0004): unknown {
  return {
    choices: [
      { message: { content: typeof content === "string" ? content : JSON.stringify(content) } },
    ],
    usage: { prompt_tokens: 740, completion_tokens: 130, total_tokens: 870, cost },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fail(status: number, body = "nope"): Response {
  return new Response(body, { status });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(responses: readonly (() => Response)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected call #${calls.length}`);
    return Promise.resolve(next());
  };
  return { fetch: fetchImpl, calls };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? "{}")) as Record<string, unknown>;
}

function client(fetchImpl: FetchLike, sleep = vi.fn(async () => {})): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "sk-test",
    fetchImpl,
    sleep,
    backoffMs: 1,
    referer: "https://example.test",
    title: "eval",
  });
}

describe("OpenRouterClient.chat", () => {
  it("sends json_schema, usage.include and the auth headers", async () => {
    const { fetch, calls } = recorder([() => ok(completion(CARD))]);
    const result = await client(fetch).chat({
      model: "anthropic/claude-sonnet-5",
      system: "SYS",
      user: "langFrom=de\nlangTo=ru\ninput: tisch",
      schema: CARD_JSON_SCHEMA,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["HTTP-Referer"]).toBe("https://example.test");
    expect(headers["X-Title"]).toBe("eval");

    const body = bodyOf(calls[0]);
    expect(body.model).toBe("anthropic/claude-sonnet-5");
    expect(body.usage).toEqual({ include: true });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "flashcard", strict: true, schema: CARD_JSON_SCHEMA },
    });
    expect((body.messages as { role: string; content: string }[])[0]?.content).toBe("SYS");

    expect(result.mode).toBe("json_schema");
    expect(result.attempts).toBe(1);
    expect(JSON.parse(result.text)).toEqual(CARD);
    expect(result.usage).toEqual({
      promptTokens: 740,
      completionTokens: 130,
      totalTokens: 870,
      costUsd: 0.0004,
    });
  });

  it("falls back to json_object with the schema in the system prompt on a 400", async () => {
    const { fetch, calls } = recorder([
      () => fail(400, "json_schema is not supported by this provider"),
      () => ok(completion(CARD)),
    ]);
    const result = await client(fetch).chat({
      model: "deepseek/deepseek-v4-flash",
      system: "SYS",
      user: "input: tisch",
      schema: CARD_JSON_SCHEMA,
    });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).response_format).toMatchObject({ type: "json_schema" });
    expect(bodyOf(calls[1]).response_format).toEqual({ type: "json_object" });
    const system = (bodyOf(calls[1]).messages as { content: string }[])[0]?.content ?? "";
    expect(system).toContain("SYS");
    expect(system).toContain('"detectedLang"');
    expect(result.mode).toBe("json_object");
    expect(result.attempts).toBe(2);
  });

  it("does not fall back when the mode was forced", async () => {
    const { fetch, calls } = recorder([() => fail(400)]);
    await expect(
      client(fetch).chat({
        model: "m",
        system: "SYS",
        user: "u",
        schema: CARD_JSON_SCHEMA,
        mode: "json_object",
      }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 with backoff and then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch, calls } = recorder([
      () => fail(429, "rate limited"),
      () => ok(completion(CARD)),
    ]);
    const result = await client(fetch, sleep).chat({
      model: "m",
      system: "SYS",
      user: "u",
      schema: CARD_JSON_SCHEMA,
    });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(2);
    expect(result.mode).toBe("json_schema");
  });

  it("gives up after three attempts on 5xx", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch, calls } = recorder([() => fail(503), () => fail(503), () => fail(503)]);
    await expect(
      client(fetch, sleep).chat({ model: "m", system: "S", user: "u", schema: CARD_JSON_SCHEMA }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries network failures too", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve(ok(completion(CARD)));
    };
    const result = await client(fetchImpl).chat({
      model: "m",
      system: "S",
      user: "u",
      schema: CARD_JSON_SCHEMA,
    });
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });
});

describe("listModels", () => {
  it("returns the ids", async () => {
    const { fetch, calls } = recorder([
      () => ok({ data: [{ id: "anthropic/claude-opus-5" }, { id: "openai/gpt-5-mini" }] }),
    ]);
    const models = await client(fetch).listModels();
    expect(models).toEqual(["anthropic/claude-opus-5", "openai/gpt-5-mini"]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[0]?.init?.method).toBe("GET");
  });
});

describe("payload parsing", () => {
  it("reads content given as an array of parts", () => {
    expect(
      parseContent({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }),
    ).toBe("ab");
  });

  it("throws when there is no content", () => {
    expect(() => parseContent({ choices: [] })).toThrow(OpenRouterError);
  });

  it("defaults usage to zeros", () => {
    expect(parseUsage({})).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});

describe("suggestModels", () => {
  const available = [
    "anthropic/claude-opus-4.1",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-flash",
    "openai/gpt-4o-mini",
  ];

  it("suggests ids sharing a long substring", () => {
    expect(suggestModels("anthropic/claude-opus-5", available)).toContain(
      "anthropic/claude-opus-4.1",
    );
    expect(suggestModels("google/gemini-3.7-flash", available)).toContain(
      "google/gemini-2.5-flash",
    );
  });

  it("returns nothing for a completely unrelated id", () => {
    expect(suggestModels("zzz", available)).toEqual([]);
  });
});

describe("createLimiter", () => {
  it("never runs more than `max` tasks at once and preserves results", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (value: number) =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value;
      });
    const results = await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("releases the slot when a task rejects", async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limit(() => Promise.resolve("fine"))).resolves.toBe("fine");
  });
});

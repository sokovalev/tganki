import { describe, expect, it } from "vitest";
import {
  createOpenRouterCardGenerator,
  createStaticLanguageResolver,
} from "../src/llm/generator.js";
import type { FetchLike } from "../src/llm/openrouter.js";
import type { GeneratedCard } from "../src/llm/types.js";
import { GenerationError } from "../src/llm/types.js";
import { createLogger } from "../src/logger.js";

const CARD: GeneratedCard = {
  front: "reluctant",
  back: "неохотный, сопротивляющийся",
  transcription: "rɪˈlʌktənt",
  example: "She was reluctant to go.",
  exampleTr: "Она не хотела идти.",
  pos: "adjective",
  detectedLang: "en",
};

const logger = createLogger({ level: "silent", pretty: false });

function reply(card: Partial<GeneratedCard> | string, finishReason = "stop"): Response {
  const content = typeof card === "string" ? card : JSON.stringify({ ...CARD, ...card });
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200 },
  );
}

interface Harness {
  fetchImpl: FetchLike;
  bodies: Record<string, unknown>[];
}

function fetching(responses: readonly (() => Response | Promise<Response>)[]): Harness {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1];
    return next!();
  };
  return { fetchImpl, bodies };
}

function generator(harness: Harness, overrides: { reasoningEffort?: "low" } = {}) {
  return createOpenRouterCardGenerator({
    apiKey: "sk-test",
    model: "google/gemini-3.7-flash",
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
    logger,
    ...overrides,
  });
}

const input = { text: "reluctant", langFrom: "en", langTo: "ru" };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationError);
    return (error as GenerationError).reason;
  }
  throw new Error("expected a GenerationError");
}

describe("createOpenRouterCardGenerator", () => {
  it("sends the shared prompt and returns the parsed card", async () => {
    const harness = fetching([() => reply({})]);
    const card = await generator(harness).generate(input);
    expect(card).toEqual(CARD);

    const body = harness.bodies[0]!;
    expect(body.model).toBe("google/gemini-3.7-flash");
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toContain("You build one flashcard");
    expect(messages[1]?.content).toBe("langFrom=en\nlangTo=ru\ninput: reluctant");
    expect(body.reasoning).toBeUndefined();
  });

  it("leaves a reasoning model room to answer", async () => {
    // The client default (600) truncates the JSON of a thinking model.
    const harness = fetching([() => reply({})]);
    await generator(harness).generate(input);
    expect(harness.bodies[0]?.max_tokens).toBe(4_000);
  });

  it("says so when the answer was cut off by the token budget", async () => {
    const truncated = '{"front":"უნდომელი","back":"reluctant';
    const harness = fetching([() => reply(truncated, "length")]);
    try {
      await generator(harness).generate(input);
      throw new Error("expected a GenerationError");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).reason).toBe("invalid_output");
      expect((error as GenerationError).message).toContain("finish_reason=length");
    }
  });

  it("does not blame the budget for a reply that is simply wrong", async () => {
    const harness = fetching([() => reply("sorry, I cannot do that")]);
    const error = await generator(harness)
      .generate(input)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).message).not.toContain("finish_reason");
  });

  it("passes the reasoning effort only when configured", async () => {
    const harness = fetching([() => reply({})]);
    await generator(harness, { reasoningEffort: "low" }).generate(input);
    expect(harness.bodies[0]?.reasoning).toEqual({ effort: "low" });
  });

  it("keeps the foreign headword when the user typed their own language", async () => {
    const harness = fetching([() => reply({ detectedLang: "ru" })]);
    const card = await generator(harness).generate({ ...input, text: "неохотный" });
    expect(card.front).toBe("reluctant");
    expect(card.detectedLang).toBe("ru");
    const messages = harness.bodies[0]?.messages as { content: string }[];
    expect(messages[1]?.content).toContain("input: неохотный");
  });

  it("normalizes the card the way the eval does", async () => {
    const harness = fetching([
      () => reply({ transcription: "/rɪˈlʌktənt/", front: " reluctant " }),
    ]);
    const card = await generator(harness).generate(input);
    expect(card.transcription).toBe("rɪˈlʌktənt");
    expect(card.front).toBe("reluctant");
  });

  it("reports junk input as invalid_output", async () => {
    const harness = fetching([
      () =>
        reply({
          front: "🙂",
          back: "",
          transcription: "",
          example: "",
          exampleTr: "",
          pos: "other",
          detectedLang: "und",
        }),
    ]);
    expect(await reason(generator(harness).generate({ ...input, text: "🙂" }))).toBe(
      "invalid_output",
    );
  });

  it("reports an empty headword as invalid_output", async () => {
    const harness = fetching([() => reply({ front: "" })]);
    expect(await reason(generator(harness).generate(input))).toBe("invalid_output");
  });

  it("reports a reply that is not JSON as invalid_output", async () => {
    const harness = fetching([() => reply("sorry, I cannot do that")]);
    expect(await reason(generator(harness).generate(input))).toBe("invalid_output");
  });

  it("reports a reply that misses fields as invalid_output", async () => {
    const harness = fetching([
      () => reply(JSON.stringify({ front: "reluctant", back: "неохотный" })),
    ]);
    expect(await reason(generator(harness).generate(input))).toBe("invalid_output");
  });

  it("reports a timeout as timeout", async () => {
    const timeout = (): Promise<Response> => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    };
    const harness = fetching([timeout, timeout, timeout]);
    expect(await reason(generator(harness).generate(input))).toBe("timeout");
    expect(harness.bodies).toHaveLength(3);
  });

  it("reports a 429 as unavailable after exhausting the retries", async () => {
    const harness = fetching([() => new Response("slow down", { status: 429 })]);
    expect(await reason(generator(harness).generate(input))).toBe("unavailable");
    expect(harness.bodies).toHaveLength(3);
  });

  it("reports a network failure as unavailable", async () => {
    const harness = fetching([() => Promise.reject(new Error("ECONNRESET"))]);
    expect(await reason(generator(harness).generate(input))).toBe("unavailable");
  });

  it("reports a rejected key as unavailable", async () => {
    const harness = fetching([() => new Response("no credits", { status: 402 })]);
    expect(await reason(generator(harness).generate(input))).toBe("unavailable");
    expect(harness.bodies).toHaveLength(1);
  });

  it("recovers a card after one retryable failure", async () => {
    const harness = fetching([() => new Response("boom", { status: 503 }), () => reply({})]);
    const card = await generator(harness).generate(input);
    expect(card.front).toBe("reluctant");
    expect(harness.bodies).toHaveLength(2);
  });
});

describe("createStaticLanguageResolver", () => {
  const resolver = createStaticLanguageResolver();

  it("resolves a name in any language to a code and a localized name", async () => {
    expect(await resolver.resolve({ text: "грузинский", uiLang: "ru" })).toEqual({
      code: "ka",
      name: "грузинский",
    });
    expect(await resolver.resolve({ text: " Georgian ", uiLang: "en" })).toEqual({
      code: "ka",
      name: "Georgian",
    });
    expect(await resolver.resolve({ text: "ქართული", uiLang: "en" })).toMatchObject({ code: "ka" });
  });

  it("returns null for something that is not a language", async () => {
    expect(await resolver.resolve({ text: "клингонский", uiLang: "ru" })).toBeNull();
  });
});

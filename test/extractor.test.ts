/**
 * The §4.3 extraction layer: what goes to OpenRouter, what survives the
 * post-processing on the way back, and how a text is prepared before either.
 * Nothing here touches the network.
 */

import { describe, expect, it } from "vitest";
import type { Deck } from "../src/db/schema.js";
import { createOpenRouterWordExtractor, EXTRACT_MAX_TOKENS } from "../src/llm/extractor.js";
import type { FetchLike } from "../src/llm/openrouter.js";
import {
  EXTRACT_JSON_SCHEMA,
  EXTRACT_SCHEMA_NAME,
  MAX_EXTRACTED_WORDS,
  matchesScript,
  parseExtraction,
  postProcessExtraction,
} from "../src/llm/prompt.js";
import { GenerationError } from "../src/llm/types.js";
import { createLogger } from "../src/logger.js";
import { guessLevel, hasLetters, stripUrls } from "../src/services/extractService.js";

const logger = createLogger({ level: "silent", pretty: false });

const REPLY = {
  detectedLang: "en",
  words: [
    { front: "reluctant", back: "неохотный", inText: "reluctant" },
    { front: "lease", back: "договор аренды", inText: "lease" },
  ],
};

function reply(payload: unknown, finishReason = "stop"): Response {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
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

function extractor(harness: Harness) {
  return createOpenRouterWordExtractor({
    apiKey: "sk-test",
    model: "google/gemini-3.7-flash",
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
    logger,
  });
}

const input = {
  text: "The tenant was reluctant to sign the lease.",
  langFrom: "en",
  langTo: "ru",
  level: "A2",
};

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationError);
    return (error as GenerationError).reason;
  }
  throw new Error("expected a GenerationError");
}

describe("createOpenRouterWordExtractor", () => {
  it("sends the extraction prompt, the schema and the bigger token budget", async () => {
    const harness = fetching([() => reply(REPLY)]);
    const result = await extractor(harness).extract(input);
    expect(result.detectedLang).toBe("en");
    expect(result.words.map((word) => word.front)).toEqual(["reluctant", "lease"]);

    const body = harness.bodies[0]!;
    expect(body.max_tokens).toBe(EXTRACT_MAX_TOKENS);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: EXTRACT_SCHEMA_NAME, strict: true, schema: EXTRACT_JSON_SCHEMA },
    });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toContain("You pick the words worth learning");
    expect(messages[1]?.content).toBe(
      "langFrom=en\nlangTo=ru\nlevel=A2\ntext:\nThe tenant was reluctant to sign the lease.",
    );
  });

  it("reports a cut-off answer as invalid output, saying it was truncated", async () => {
    const harness = fetching([() => reply('{"detectedLang":"en","words":[{"fro', "length")]);
    await expect(extractor(harness).extract(input)).rejects.toThrow(/truncated/u);
  });

  it("maps transport failures onto reasons the bot can recover from", async () => {
    const dead = fetching([() => new Response("boom", { status: 500 })]);
    expect(await reason(extractor(dead).extract(input))).toBe("unavailable");
    const junk = fetching([() => reply("not json at all")]);
    expect(await reason(extractor(junk).extract(input))).toBe("invalid_output");
  });

  it("accepts an empty word list: a text with nothing new in it is a valid answer", async () => {
    const harness = fetching([() => reply({ detectedLang: "ru", words: [] })]);
    const result = await extractor(harness).extract(input);
    expect(result).toEqual({ detectedLang: "ru", words: [] });
  });
});

describe("extraction post-processing", () => {
  const process = (words: unknown[], detectedLang = "en", langFrom = "en") =>
    postProcessExtraction({ detectedLang, words }, langFrom);

  it("collapses whitespace and lowercases the detected language", () => {
    const result = process(
      [{ front: "  give   up ", back: " сдаваться ", inText: "gave up" }],
      "EN",
    );
    expect(result.detectedLang).toBe("en");
    expect(result.words[0]).toEqual({ front: "give up", back: "сдаваться", inText: "gave up" });
  });

  it("drops entries without a word or a translation", () => {
    const result = process([
      { front: "", back: "нечто", inText: "" },
      { front: "lease", back: "", inText: "lease" },
      { front: "tenant", back: "арендатор", inText: "tenant" },
    ]);
    expect(result.words.map((word) => word.front)).toEqual(["tenant"]);
  });

  it("keeps one entry per word, whatever the model repeats", () => {
    const result = process([
      { front: "lease", back: "аренда", inText: "lease" },
      { front: "Lease", back: "договор", inText: "Lease" },
    ]);
    expect(result.words).toHaveLength(1);
  });

  it("falls back to the headword when the model forgets `inText`", () => {
    const result = process([{ front: "lease", back: "аренда" }]);
    expect(result.words[0]?.inText).toBe("lease");
  });

  it("drops words written in another script than langFrom", () => {
    // The Georgian card deck never wants a Latin "gamarjoba" as a headword.
    const result = process(
      [
        { front: "ბაზარი", back: "рынок", inText: "ბაზარში" },
        { front: "market", back: "рынок", inText: "market" },
      ],
      "ka",
      "ka",
    );
    expect(result.words.map((word) => word.front)).toEqual(["ბაზარი"]);
  });

  it("never returns more than the cap the prompt asks for", () => {
    const many = Array.from({ length: MAX_EXTRACTED_WORDS + 10 }, (_, i) => ({
      front: `word${i}`,
      back: `слово${i}`,
      inText: `word${i}`,
    }));
    expect(process(many).words).toHaveLength(MAX_EXTRACTED_WORDS);
  });

  it("reads a fenced reply the same way as a bare one", () => {
    const json = JSON.stringify(REPLY);
    expect(parseExtraction(`\`\`\`json\n${json}\n\`\`\``, "en")).toEqual(
      postProcessExtraction(REPLY, "en"),
    );
  });
});

describe("matchesScript", () => {
  it("knows the alphabet each language is written in", () => {
    expect(matchesScript("ბაზარი", "ka")).toBe(true);
    expect(matchesScript("market", "ka")).toBe(false);
    expect(matchesScript("рынок", "ru")).toBe(true);
    expect(matchesScript("market", "en")).toBe(true);
    expect(matchesScript("der Tisch", "de")).toBe(true);
    // A language we have no rule for is assumed to use Latin letters.
    expect(matchesScript("kelime", "tr")).toBe(true);
  });

  it("tolerates a stray foreign letter but not a foreign word", () => {
    expect(matchesScript("სახლი (SMS)", "ka")).toBe(true);
    expect(matchesScript("", "en")).toBe(false);
    expect(matchesScript("123", "en")).toBe(false);
  });
});

describe("preparing a text (extractService)", () => {
  it("cuts links out and keeps the paragraphs", () => {
    expect(stripUrls("Смотри https://example.com/a?b=1 вот тут")).toBe("Смотри вот тут");
    expect(stripUrls("www.test.ge/page и ещё")).toBe("и ещё");
    expect(stripUrls("первый абзац\nвторой абзац")).toBe("первый абзац\nвторой абзац");
    expect(stripUrls("https://example.com/only/a/link")).toBe("");
  });

  it("knows when there is nothing left to look at", () => {
    expect(hasLetters("სახლი")).toBe(true);
    expect(hasLetters("🙂🙂 123 —")).toBe(false);
    expect(hasLetters("")).toBe(false);
  });
});

describe("guessLevel", () => {
  const deck = (level: string | null, kind: Deck["kind"] = "builtin", langFrom = "ka"): Deck => ({
    id: 1,
    ownerId: kind === "builtin" ? null : 1,
    slug: null,
    title: "deck",
    description: null,
    langFrom,
    langTo: "ru",
    kind,
    level,
    isPublic: false,
    publicId: null,
    createdAt: new Date(),
  });

  it("takes the highest builtin level of the language being learned", () => {
    expect(guessLevel([deck("A1"), deck("A2")], "ka")).toBe("A2");
    expect(guessLevel([deck("B1"), deck("A1")], "ka")).toBe("B1");
  });

  it("reads the alphabet deck as the very beginning", () => {
    expect(guessLevel([deck("A0")], "ka")).toBe("A1");
  });

  it("falls back to A2 without a builtin deck in that language", () => {
    expect(guessLevel([], "ka")).toBe("A2");
    expect(guessLevel([deck("B1", "user")], "ka")).toBe("A2");
    expect(guessLevel([deck("B1", "builtin", "en")], "ka")).toBe("A2");
  });
});

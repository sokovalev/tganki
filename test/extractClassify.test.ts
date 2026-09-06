/**
 * The three buckets a word from a text falls into (SPEC §4.3, §3.7): what the
 * user already **knows**, what merely waits **in a deck** they are subscribed
 * to, and what is **fresh**. The rules live in `notesRepo.classifyFronts`;
 * `classifyFake` is their JS twin, so these tests pin the behaviour the service
 * is built on, and the service's own handling of each bucket.
 */

import { describe, expect, it } from "vitest";
import type { CachedCardGenerator } from "../src/llm/cache.js";
import type { ExtractedWord, ExtractedWords } from "../src/llm/types.js";
import type { AddService } from "../src/services/addService.js";
import { createExtractService } from "../src/services/extractService.js";
import { createLimits } from "../src/services/limits.js";
import { classifyFake, type LibraryNote, NOW } from "./helpers/fakeBot.js";
import { makeUser } from "./helpers/fakeSession.js";

const USER = makeUser({ id: 1, langFrom: "ka", langTo: "ru" });
const TOP_500 = "Грузинский Top 500 · A1";

const WORDS: ExtractedWord[] = [
  { front: "ბაზარი", back: "рынок", inText: "ბაზარში" },
  { front: "ხილი", back: "фрукты", inText: "ხილი" },
];

/** The generator is never touched by `extract`: a word costs nothing to sort. */
const generator: CachedCardGenerator = {
  generateWithMeta: () => {
    throw new Error("the extraction step must not generate anything");
  },
  generate: () => {
    throw new Error("the extraction step must not generate anything");
  },
};

const limits = createLimits(
  {
    countOwnDecks: async () => 0,
    countOwnNotes: async () => 0,
    countGenerationsSince: async () => 0,
    countExtractionsSince: async () => 0,
  },
  { proEnabled: false },
);

/** The service over one classification fixture; `add` is out of this picture. */
function service(input: { known?: string[]; library?: LibraryNote[]; words?: ExtractedWord[] }) {
  const answer: ExtractedWords = { detectedLang: "ka", words: input.words ?? WORDS };
  return createExtractService({
    port: {
      async classifyFronts({ fronts }) {
        return classifyFake({
          fronts,
          known: new Set(input.known ?? []),
          library: input.library ?? [],
        });
      },
      async listSubscribedDecks() {
        return [];
      },
      async startCard() {
        return 1;
      },
    },
    limits,
    add: {} as unknown as AddService,
    llm: { model: "test/model", generator, extractor: { extract: async () => answer } },
  });
}

async function sort(input: { known?: string[]; library?: LibraryNote[] }) {
  const result = await service(input).extract({ user: USER, text: "…", now: NOW });
  if (result.kind !== "extracted") throw new Error(`unexpected result: ${result.kind}`);
  return {
    offered: result.words.map((word) => word.front),
    inDeck: Object.fromEntries(
      result.words.flatMap((word) => (word.inDeck ? [[word.front, word.inDeck]] : [])),
    ),
    known: result.known,
    dropped: result.dropped,
  };
}

describe("classifying the words of a text (SPEC §4.3)", () => {
  it("drops a word that has a known_words row", async () => {
    const sorted = await sort({ known: ["ხილი"] });
    expect(sorted.offered).toEqual(["ბაზარი"]);
    expect(sorted.known).toEqual(["ხილი"]);
    expect(sorted.dropped).toBe(1);
  });

  it("drops a word whose card the user has already studied", async () => {
    const sorted = await sort({
      library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500, reps: 3 }],
    });
    expect(sorted.offered).toEqual(["ბაზარი"]);
    expect(sorted.known).toEqual(["ხილი"]);
  });

  it("drops a word the user already has a note of their own for", async () => {
    const sorted = await sort({
      library: [{ front: "ხილი", noteId: 7, deckTitle: "Мои слова · KA", owned: true }],
    });
    expect(sorted.offered).toEqual(["ბაზარი"]);
    expect(sorted.known).toEqual(["ხილი"]);
  });

  it("offers a word that only waits in a subscribed deck, naming the deck", async () => {
    const sorted = await sort({ library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500 }] });
    expect(sorted.offered).toEqual(["ბაზარი", "ხილი"]);
    expect(sorted.inDeck).toEqual({ ხილი: { noteId: 42, deckTitle: TOP_500 } });
    expect(sorted.dropped).toBe(0);
  });

  it("counts an untouched new card as not started yet", async () => {
    const sorted = await sort({
      library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500, reps: 0 }],
    });
    expect(sorted.offered).toEqual(["ბაზარი", "ხილი"]);
    expect(sorted.inDeck).toEqual({ ხილი: { noteId: 42, deckTitle: TOP_500 } });
  });

  it("keeps a word nothing is known about fresh", async () => {
    const sorted = await sort({ library: [{ front: "სახლი", noteId: 5, deckTitle: TOP_500 }] });
    expect(sorted.offered).toEqual(["ბაზარი", "ხილი"]);
    expect(sorted.inDeck).toEqual({});
    expect(sorted.dropped).toBe(0);
  });

  it("lets knowledge win over a deck the word also sits in", async () => {
    const sorted = await sort({
      library: [
        { front: "ხილი", noteId: 42, deckTitle: TOP_500 },
        { front: "ხილი", noteId: 7, deckTitle: "Мои слова · KA", owned: true },
      ],
    });
    expect(sorted.offered).toEqual(["ბაზარი"]);
    expect(sorted.known).toEqual(["ხილი"]);
  });

  it("treats a deck the user has unsubscribed from as no deck at all", async () => {
    const sorted = await sort({
      library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500, subscribed: false }],
    });
    expect(sorted.offered).toEqual(["ბაზარი", "ხილი"]);
    expect(sorted.inDeck).toEqual({});
  });
});

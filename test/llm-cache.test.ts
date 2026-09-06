import { describe, expect, it } from "vitest";
import {
  type CacheStore,
  cacheKey,
  createMemoryCacheStore,
  normalizeCacheText,
  withCache,
} from "../src/llm/cache.js";
import type { CardGenerator, GenerateCardInput, GeneratedCard } from "../src/llm/types.js";

const CARD: GeneratedCard = {
  front: "reluctant",
  back: "неохотный, сопротивляющийся",
  transcription: "rɪˈlʌktənt",
  example: "She was reluctant to go.",
  exampleTr: "Она не хотела идти.",
  pos: "adjective",
  detectedLang: "en",
};

function counting(card: GeneratedCard | ((input: GenerateCardInput) => GeneratedCard)): {
  generator: CardGenerator;
  calls: GenerateCardInput[];
} {
  const calls: GenerateCardInput[] = [];
  return {
    calls,
    generator: {
      async generate(input) {
        calls.push(input);
        return typeof card === "function" ? card(input) : card;
      },
    },
  };
}

const input = (text: string): GenerateCardInput => ({ text, langFrom: "en", langTo: "ru" });

describe("cache keys", () => {
  it("normalizes case, whitespace and unicode composition", () => {
    expect(normalizeCacheText("  Der   Tisch ")).toBe("der tisch");
    expect(normalizeCacheText("Café")).toBe(normalizeCacheText("café"));
  });

  it("carries the version and the language pair", () => {
    expect(cacheKey(input("  Reluctant "))).toBe("card:v2:en:ru:reluctant");
    expect(cacheKey({ text: "тест", langFrom: "ka", langTo: "ru" })).toBe("card:v2:ka:ru:тест");
  });
});

describe("withCache", () => {
  it("calls the model once and serves the second request from the cache", async () => {
    const { generator, calls } = counting(CARD);
    const cached = withCache(generator, createMemoryCacheStore());

    const first = await cached.generateWithMeta(input("reluctant"));
    expect(first).toEqual({ card: CARD, cached: false });

    const second = await cached.generateWithMeta(input("  Reluctant  "));
    expect(second).toEqual({ card: CARD, cached: true });
    expect(calls).toHaveLength(1);
  });

  it("keys by the language pair, not just the word", async () => {
    const { calls, generator } = counting(CARD);
    const cached = withCache(generator, createMemoryCacheStore());
    await cached.generateWithMeta({ text: "reluctant", langFrom: "en", langTo: "ru" });
    await cached.generateWithMeta({ text: "reluctant", langFrom: "en", langTo: "en" });
    expect(calls).toHaveLength(2);
  });

  it("also stores the card under its canonical headword", async () => {
    const { generator, calls } = counting(CARD);
    const store = createMemoryCacheStore();
    const cached = withCache(generator, store);

    // Reverse direction: the user typed Russian, the card is about "reluctant".
    await cached.generateWithMeta(input("Неохотный"));
    expect(store.size()).toBe(2);
    expect(await store.get("card:v2:en:ru:неохотный")).toEqual(CARD);

    const direct = await cached.generateWithMeta(input("reluctant"));
    expect(direct.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stores only one row when the headword is what was typed", async () => {
    const store = createMemoryCacheStore();
    await withCache(counting(CARD).generator, store).generateWithMeta(input("reluctant"));
    expect(store.size()).toBe(1);
  });

  it("applies the phrase rule to cache hits from before the rule existed", async () => {
    const phraseInput: GenerateCardInput = { text: "სახლში ვარ.", langFrom: "ka", langTo: "ru" };
    const store = createMemoryCacheStore({
      [cacheKey(phraseInput)]: {
        ...CARD,
        front: "სახლში ყოფნა",
        back: "быть дома",
        detectedLang: "ka",
      },
    });
    const { generator, calls } = counting(CARD);
    const result = await withCache(generator, store).generateWithMeta(phraseInput);
    expect(result.cached).toBe(true);
    expect(result.card.front).toBe("სახლში ვარ");
    expect(calls).toHaveLength(0);
  });

  it("treats a payload that no longer validates as a miss", async () => {
    const store = createMemoryCacheStore({
      "card:v2:en:ru:reluctant": { front: "reluctant", back: 42 },
    });
    const { generator, calls } = counting(CARD);
    const result = await withCache(generator, store).generateWithMeta(input("reluctant"));
    expect(result).toEqual({ card: CARD, cached: false });
    expect(calls).toHaveLength(1);
  });

  it("degrades to plain generation when the store is broken", async () => {
    const broken: CacheStore = {
      async get() {
        throw new Error("db is down");
      },
      async set() {
        throw new Error("db is down");
      },
    };
    const { generator, calls } = counting(CARD);
    const result = await withCache(generator, broken).generateWithMeta(input("reluctant"));
    expect(result).toEqual({ card: CARD, cached: false });
    expect(calls).toHaveLength(1);
  });

  it("propagates generation failures instead of caching them", async () => {
    const store = createMemoryCacheStore();
    const failing: CardGenerator = {
      async generate() {
        throw new Error("nope");
      },
    };
    await expect(withCache(failing, store).generateWithMeta(input("x"))).rejects.toThrow("nope");
    expect(store.size()).toBe(0);
  });

  it("keeps the plain `generate` shape of the contract", async () => {
    const cached = withCache(counting(CARD).generator, createMemoryCacheStore());
    expect(await cached.generate(input("reluctant"))).toEqual(CARD);
  });

  it("first writer of a key wins", async () => {
    const store = createMemoryCacheStore();
    let n = 0;
    const { generator } = counting(() => {
      n += 1;
      return { ...CARD, back: `перевод ${n}` };
    });
    const cached = withCache(generator, store);
    await cached.generateWithMeta(input("reluctant"));
    const second = await cached.generateWithMeta(input("reluctant"));
    expect(second.card.back).toBe("перевод 1");
  });
});

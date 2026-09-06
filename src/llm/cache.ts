/**
 * Generation cache (SPEC §4.1a): keyed by `(langFrom, langTo, word)` and shared
 * by every user, because "reluctant" costs the same to generate once as it does
 * to generate a thousand times. A hit also keeps the free daily budget intact —
 * only a real model call counts (SPEC §9.1).
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { generatedCache } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { generatedCardSchema } from "./prompt.js";
import type { CardGenerator, GenerateCardInput, GeneratedCard } from "./types.js";

/** Bump when a prompt change makes the stored cards stale. */
export const CACHE_VERSION = "v1";

export interface CacheStore {
  /** The stored payload, or null when nothing is cached under `key`. */
  get(key: string): Promise<unknown | null>;
  /** Writes the payload. First writer wins; a later one is a no-op. */
  set(key: string, payload: unknown): Promise<void>;
}

export interface GeneratedWithMeta {
  card: GeneratedCard;
  /** False when the model was actually called — this is what the budget counts. */
  cached: boolean;
}

export interface CachedCardGenerator extends CardGenerator {
  generateWithMeta(input: GenerateCardInput): Promise<GeneratedWithMeta>;
}

/** NFC, trimmed, whitespace-collapsed, lowercased — same shape as `frontNorm`. */
export function normalizeCacheText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** `card:v1:en:ru:reluctant` — one row per word and language pair. */
export function cacheKey(input: GenerateCardInput): string {
  return `card:${CACHE_VERSION}:${input.langFrom}:${input.langTo}:${normalizeCacheText(input.text)}`;
}

/** A payload that no longer matches the schema is treated as a miss. */
function parsePayload(payload: unknown): GeneratedCard | null {
  const parsed = generatedCardSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Wraps a generator with a read-through cache. Cache failures are never fatal:
 * a broken store degrades to "always generate", it never breaks the bot.
 */
export function withCache(
  generator: CardGenerator,
  store: CacheStore,
  options: { logger?: Logger } = {},
): CachedCardGenerator {
  const warn = (error: unknown, message: string): void => {
    options.logger?.warn({ err: error }, message);
  };

  const read = async (key: string): Promise<GeneratedCard | null> => {
    try {
      const payload = await store.get(key);
      return payload === null || payload === undefined ? null : parsePayload(payload);
    } catch (error) {
      warn(error, "generation cache read failed");
      return null;
    }
  };

  const write = async (key: string, card: GeneratedCard): Promise<void> => {
    try {
      await store.set(key, card);
    } catch (error) {
      warn(error, "generation cache write failed");
    }
  };

  const generateWithMeta = async (input: GenerateCardInput): Promise<GeneratedWithMeta> => {
    const key = cacheKey(input);
    const hit = await read(key);
    if (hit) return { card: hit, cached: true };

    const card = await generator.generate(input);
    await write(key, card);
    // The canonical form is what the next user is most likely to type, and for
    // a reverse-direction input ("неохотный") it is a different key entirely.
    const canonicalKey = cacheKey({ ...input, text: card.front });
    if (canonicalKey !== key) await write(canonicalKey, card);
    return { card, cached: false };
  };

  return {
    generateWithMeta,
    async generate(input) {
      return (await generateWithMeta(input)).card;
    },
  };
}

/** `generated_cache` table; the first writer of a key wins. */
export function createDbCacheStore(db: Database, logger?: Logger): CacheStore {
  return {
    async get(key) {
      const [row] = await db
        .select({ payload: generatedCache.payload })
        .from(generatedCache)
        .where(eq(generatedCache.key, key))
        .limit(1);
      return row?.payload ?? null;
    },

    async set(key, payload) {
      try {
        await db.insert(generatedCache).values({ key, payload }).onConflictDoNothing();
      } catch (error) {
        logger?.warn({ err: error, key }, "could not store a generated card");
      }
    },
  };
}

/** In-memory store for tests and for running without a database. */
export function createMemoryCacheStore(initial: Record<string, unknown> = {}): CacheStore & {
  size(): number;
} {
  const rows = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key) {
      return rows.has(key) ? rows.get(key) : null;
    },
    async set(key, payload) {
      if (!rows.has(key)) rows.set(key, payload);
    },
    size: () => rows.size,
  };
}

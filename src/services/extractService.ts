/**
 * «Слова из текста» (SPEC §4.3): the model reads a text the user pasted, names
 * the words they probably do not know yet, we drop the ones they already have,
 * and the checklist they tick turns into real cards through the same cached
 * card generator as §4.1a.
 */

import type { Deck, Note, User } from "../db/schema.js";
import { normalizeFrontValue } from "../db/sql.js";
import type { CachedCardGenerator } from "../llm/cache.js";
import { createLimiter } from "../llm/openrouter.js";
import {
  DEFAULT_EXTRACT_LEVEL,
  EXTRACT_LEVELS,
  type ExtractLevel,
  MAX_EXTRACTED_WORDS,
} from "../llm/prompt.js";
import { type ExtractedWord, GenerationError, type WordExtractor } from "../llm/types.js";
import type { AddService } from "./addService.js";
import type { LimitCheck, Limits } from "./limits.js";

/** How much of a long text we send. Everything past this is cut, and we say so. */
export const MAX_EXTRACT_CHARS = 3_000;
/** Cards generated in parallel while adding a checklist. */
export const EXTRACT_CONCURRENCY = 3;

/** `https://…`, `www.…`, and a bare `example.com/path` in a few common zones. */
const URL_PATTERN = /(https?:\/\/\S+|www\.\S+|\b[\w-]+\.(?:com|org|net|ru|ge|io|me)\/\S*)/giu;

/**
 * Links carry no vocabulary and eat the character budget, so they go first.
 * Line breaks survive: paragraphs are part of what the model reads.
 */
export function stripUrls(text: string): string {
  return text
    .replace(URL_PATTERN, " ")
    .replace(/[^\S\n]+/gu, " ")
    .trim();
}

/** True when there is at least one letter left to look for words in. */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

const LEVEL_ORDER = ["A0", "A1", "A2", "B1", "B2", "C1", "C2"];

/**
 * The level we tell the model about: the highest builtin deck the user studies
 * in the language they are learning, clamped into A1…B1. A user with no
 * builtin decks (their own words only) gets the A2 default (SPEC §4.3).
 */
export function guessLevel(decks: readonly Deck[], langFrom: string): ExtractLevel {
  let best = -1;
  for (const deck of decks) {
    if (deck.kind !== "builtin" || deck.langFrom !== langFrom) continue;
    best = Math.max(best, LEVEL_ORDER.indexOf((deck.level ?? "").toUpperCase()));
  }
  if (best < 0) return DEFAULT_EXTRACT_LEVEL;
  const label = LEVEL_ORDER[best] ?? DEFAULT_EXTRACT_LEVEL;
  if (label === "A0") return "A1";
  return (EXTRACT_LEVELS as readonly string[]).includes(label) ? (label as ExtractLevel) : "B1";
}

export interface ExtractPort {
  /** Normalized fronts the user already knows or is already learning (§3.7). */
  findKnownFronts(input: { userId: number; langFrom: string; fronts: string[] }): Promise<string[]>;
  /** Every deck the user is subscribed to — the level guess reads their levels. */
  listSubscribedDecks(userId: number): Promise<Deck[]>;
}

/** The LLM half of the feature; absent when `OPENROUTER_API_KEY` is unset. */
export interface ExtractLlm {
  extractor: WordExtractor;
  /** Same cached generator as §4.1a: a word someone added before is free. */
  generator: CachedCardGenerator;
  /** OpenRouter model id, recorded on `text_extracted`. */
  model: string;
}

/** What one model call over a text produced. */
export interface ExtractMeta {
  detectedLang: string;
  /** Characters actually sent to the model. */
  chars: number;
  latencyMs: number;
  /** The text was longer than `MAX_EXTRACT_CHARS`. */
  truncated: boolean;
}

export type ExtractResult =
  | ({ kind: "extracted"; words: ExtractedWord[]; dropped: number } & ExtractMeta)
  /** The text is in the user's own language: nothing to learn from it. */
  | ({ kind: "native" } & ExtractMeta)
  /** Neither langFrom nor langTo — a text in a third language, or junk. */
  | ({ kind: "wrong_lang" } & ExtractMeta)
  | { kind: "limit"; check: LimitCheck }
  | { kind: "failed"; reason: GenerationError["reason"] }
  /** No OpenRouter key: the feature is off (SPEC §4.3). */
  | { kind: "unavailable" };

export interface AddedWord {
  front: string;
  back: string;
  note: Note;
}

/** One call to the card generator, as `word_generated` wants to record it. */
export interface GenerationMeta {
  cached: boolean;
  latencyMs: number;
}

export interface AddWordsResult {
  deck: Deck;
  added: AddedWord[];
  /** Words that turned out to be duplicates by the time we got to them. */
  skipped: number;
  /** Words left ungenerated because the daily AI budget ran out (§9.1). */
  budgetSkipped: number;
  generations: GenerationMeta[];
  /** Set when the Free note budget stopped the batch. */
  noteLimit?: LimitCheck;
}

export function createExtractService(input: {
  port: ExtractPort;
  limits: Limits;
  add: AddService;
  llm: ExtractLlm | null;
}) {
  const { port, limits, add, llm } = input;
  const pair = (user: User): { langFrom: string; langTo: string } => ({
    langFrom: user.langFrom ?? "en",
    langTo: user.langTo ?? user.uiLang,
  });

  return {
    /** null when `OPENROUTER_API_KEY` is unset: §4.3 is off entirely. */
    llm,

    /**
     * One model call over the text: what it found, minus everything the user
     * already knows. The daily budget is checked first, so a text that is over
     * the limit never costs a request.
     */
    async extract(input: { user: User; text: string; now: Date }): Promise<ExtractResult> {
      if (!llm) return { kind: "unavailable" };
      const budget = await limits.canExtract(input.user, input.now);
      if (!budget.allowed) return { kind: "limit", check: budget };

      const { langFrom, langTo } = pair(input.user);
      const cleaned = stripUrls(input.text);
      const truncated = cleaned.length > MAX_EXTRACT_CHARS;
      const text = truncated ? cleaned.slice(0, MAX_EXTRACT_CHARS) : cleaned;
      const level = guessLevel(await port.listSubscribedDecks(input.user.id), langFrom);

      const started = Date.now();
      let detectedLang: string;
      let words: ExtractedWord[];
      try {
        const result = await llm.extractor.extract({ text, langFrom, langTo, level });
        detectedLang = result.detectedLang;
        words = result.words;
      } catch (error) {
        const reason = error instanceof GenerationError ? error.reason : "unavailable";
        return { kind: "failed", reason };
      }
      const meta: ExtractMeta = {
        detectedLang,
        chars: text.length,
        latencyMs: Date.now() - started,
        truncated,
      };
      if (detectedLang === langTo && langTo !== langFrom) return { kind: "native", ...meta };
      if (detectedLang !== langFrom) return { kind: "wrong_lang", ...meta };

      const known = new Set(
        await port.findKnownFronts({
          userId: input.user.id,
          langFrom,
          fronts: words.map((word) => word.front),
        }),
      );
      const fresh = words
        .filter((word) => !known.has(normalizeFrontValue(word.front)))
        .slice(0, MAX_EXTRACTED_WORDS);
      return {
        kind: "extracted",
        words: fresh,
        dropped: words.length - fresh.length,
        ...meta,
      };
    },

    /**
     * Turns the ticked words into cards. The user approved `front — back` on
     * the checklist, so those two are saved as shown; the model only fills in
     * the transcription and the example, and only when it answered about the
     * same word. Words the budget does not cover are skipped, not degraded.
     */
    async addWords(input: {
      user: User;
      words: ReadonlyArray<{ front: string; back: string }>;
      deckId?: number | null;
      personalTitle: string;
      now: Date;
    }): Promise<AddWordsResult> {
      const deck = await add.resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      const { langFrom, langTo } = pair(input.user);
      const budget = await limits.canGenerate(input.user, input.now);
      // The daily budget is counted from events, which are written after the
      // fact, so the batch keeps its own tally and gives a cache hit back.
      let remaining = budget.allowed ? budget.limit - budget.used : 0;
      const generations: GenerationMeta[] = [];
      const limit = createLimiter(EXTRACT_CONCURRENCY);

      const extras = async (
        front: string,
      ): Promise<{ transcription?: string; example?: string; exampleTr?: string } | "budget"> => {
        if (!llm) return {};
        if (remaining < 1) return "budget";
        remaining -= 1;
        const started = Date.now();
        try {
          const { card, cached } = await llm.generator.generateWithMeta({
            text: front,
            langFrom,
            langTo,
          });
          if (cached) remaining += 1;
          generations.push({ cached, latencyMs: Date.now() - started });
          // A card about a different headword tells us nothing about this word.
          if (normalizeFrontValue(card.front) !== normalizeFrontValue(front)) return {};
          return {
            ...(card.transcription ? { transcription: card.transcription } : {}),
            ...(card.example ? { example: card.example, exampleTr: card.exampleTr } : {}),
          };
        } catch {
          // Generation never blocks adding (SPEC §4.1a): save the plain pair.
          remaining += 1;
          return {};
        }
      };

      type Outcome =
        | { kind: "added"; word: AddedWord }
        | { kind: "skipped" }
        | { kind: "budget" }
        | { kind: "limit"; check: LimitCheck };

      const results = await Promise.all(
        input.words.map((word) =>
          limit(async (): Promise<Outcome> => {
            const filled = await extras(word.front);
            if (filled === "budget") return { kind: "budget" };
            const saved = await add.save({
              user: input.user,
              front: word.front,
              back: word.back,
              deckId: deck.id,
              personalTitle: input.personalTitle,
              now: input.now,
              ...filled,
            });
            if (saved.kind === "limit") return { kind: "limit", check: saved.check };
            if (saved.kind === "duplicate") return { kind: "skipped" };
            return {
              kind: "added",
              word: { front: saved.note.front, back: saved.note.back, note: saved.note },
            };
          }),
        ),
      );

      const noteLimit = results.find((result) => result.kind === "limit");
      return {
        deck,
        added: results.flatMap((result) => (result.kind === "added" ? [result.word] : [])),
        skipped: results.filter((result) => result.kind === "skipped").length,
        budgetSkipped: results.filter((result) => result.kind === "budget").length,
        generations,
        ...(noteLimit ? { noteLimit: noteLimit.check } : {}),
      };
    },
  };
}

export type ExtractService = ReturnType<typeof createExtractService>;

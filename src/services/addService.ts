import type { DuplicateNote } from "../db/repos/notes.js";
import type { Deck, Note, User } from "../db/schema.js";
import { type CachedCardGenerator, normalizeCacheText } from "../llm/cache.js";
import { type GeneratedCard, GenerationError } from "../llm/types.js";
import type { LimitCheck, Limits } from "./limits.js";

/** A bare text message longer than this is not treated as "add a word". */
export const MAX_WORD_LENGTH = 40;
export const MAX_WORD_COUNT = 3;
/** Upper bound for a multi-line paste of `word - translation` pairs. */
export const MAX_BULK_LINES = 100;

/** Dash characters accepted between a word and its translation. */
const PAIR_SEPARATOR = /\s+[-—–]\s+|\t+/u;

export interface ParsedPair {
  front: string;
  back: string;
}

/** trim + collapse internal whitespace. Case is preserved (der Tisch, iPhone). */
export function normalizeFront(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** `word - перевод`, `word — перевод`, `word – перевод` or `word<TAB>перевод`. */
export function parsePair(line: string): ParsedPair | null {
  const match = PAIR_SEPARATOR.exec(line);
  if (!match || match.index === 0) return null;
  const front = normalizeFront(line.slice(0, match.index));
  const back = normalizeFront(line.slice(match.index + match[0].length));
  if (!front || !back) return null;
  return { front, back };
}

export interface ParsedPairs {
  pairs: ParsedPair[];
  /** Non-empty lines that did not look like a pair. */
  invalid: number;
  /** True when the whole message parsed into two or more pairs. */
  bulk: boolean;
}

export function parsePairs(text: string, max = MAX_BULK_LINES): ParsedPairs {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
  const pairs: ParsedPair[] = [];
  let invalid = 0;
  for (const line of lines) {
    const pair = parsePair(line);
    if (pair) pairs.push(pair);
    else invalid += 1;
  }
  // Dedupe inside one paste, keeping the first spelling.
  const seen = new Set<string>();
  const unique = pairs.filter((pair) => {
    const key = pair.front.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { pairs: unique, invalid, bulk: unique.length > 1 };
}

/** SPEC decision 5: bare text up to 40 chars / 3 words means "add this word". */
export function isAddCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORD_LENGTH) return false;
  if (trimmed.startsWith("/")) return false;
  return trimmed.split(/\s+/u).length <= MAX_WORD_COUNT;
}

export interface AddPort {
  findDuplicates(input: { userId: number; fronts: string[] }): Promise<DuplicateNote[]>;
  createNote(input: {
    deckId: number;
    front: string;
    back: string;
    transcription?: string | null;
    example?: string | null;
    exampleTr?: string | null;
  }): Promise<Note>;
  /** Fills only the columns that are still empty; returns the fresh row. */
  fillNote(
    noteId: number,
    values: { transcription?: string; example?: string; exampleTr?: string },
  ): Promise<Note | null>;
  createNotes(deckId: number, pairs: ReadonlyArray<ParsedPair>): Promise<number>;
  findPersonalDeck(ownerId: number, langFrom: string): Promise<Deck | null>;
  createUserDeck(input: {
    ownerId: number;
    title: string;
    langFrom: string;
    langTo: string;
  }): Promise<Deck>;
  subscribe(userId: number, deckId: number): Promise<void>;
  findDeck(id: number): Promise<Deck | null>;
  listOwnDecks(ownerId: number): Promise<Deck[]>;
}

/** The LLM half of the service; absent when `OPENROUTER_API_KEY` is unset. */
export interface LlmSupport {
  generator: CachedCardGenerator;
  /** OpenRouter model id, recorded on `word_generated`. */
  model: string;
}

/** Why the bot is asking for a translation instead of generating one. */
export type AskReason = "limit" | "failed";

export type AddPreview =
  | { kind: "duplicate"; duplicate: DuplicateNote; own: boolean }
  | { kind: "ask_translation"; front: string; deck: Deck; reason?: AskReason }
  /** Generation is on and allowed: show «⏳», then call `generate`. */
  | { kind: "generate"; front: string; deck: Deck }
  | { kind: "limit"; check: LimitCheck };

export type GenerateResult =
  | {
      kind: "generated";
      card: GeneratedCard;
      /** True when the card came from `generated_cache` — the budget ignores those. */
      cached: boolean;
      latencyMs: number;
      /** The user typed langTo, so `card.front` is the foreign word (SPEC §4.1a). */
      reverse: boolean;
    }
  /**
   * The generated headword turned out to be a word the user already has. The
   * card comes along: «Добавить всё равно» shows it instead of asking again.
   */
  | {
      kind: "duplicate";
      duplicate: DuplicateNote;
      own: boolean;
      front: string;
      card: GeneratedCard;
    }
  | { kind: "failed"; reason: GenerationError["reason"] };

export interface EnrichResult {
  /** False when the model had nothing to add (or the note was already complete). */
  filled: boolean;
  cached: boolean;
  latencyMs: number;
  note: Note | null;
}

export type SaveResult =
  | { kind: "added"; deck: Deck; note: Note }
  | { kind: "duplicate"; duplicate: DuplicateNote }
  | { kind: "limit"; check: LimitCheck };

export type BulkResult =
  | { kind: "added"; deck: Deck; added: number; skipped: number; invalid: number }
  | { kind: "limit"; check: LimitCheck };

/** A word can sit in several subscribed decks; the user's own copy wins (SPEC §4.1). */
function pickDuplicate(notes: DuplicateNote[], userId: number): DuplicateNote | undefined {
  return notes.find((note) => note.deckOwnerId === userId) ?? notes[0];
}

export function createAddService(port: AddPort, limits: Limits, llm: LlmSupport | null = null) {
  const pair = (user: User): { langFrom: string; langTo: string } => ({
    langFrom: user.langFrom ?? "en",
    langTo: user.langTo ?? user.uiLang,
  });

  const duplicateOf = async (user: User, front: string): Promise<DuplicateNote | undefined> =>
    pickDuplicate(await port.findDuplicates({ userId: user.id, fronts: [front] }), user.id);

  /** The user's own deck for the language they are learning, created on demand. */
  async function personalDeck(user: User, title: string): Promise<Deck> {
    const langFrom = user.langFrom ?? "en";
    const langTo = user.langTo ?? user.uiLang;
    const existing = await port.findPersonalDeck(user.id, langFrom);
    if (existing) return existing;
    const deck = await port.createUserDeck({
      ownerId: user.id,
      title,
      langFrom,
      langTo,
    });
    await port.subscribe(user.id, deck.id);
    return deck;
  }

  async function resolveDeck(user: User, deckId: number | null, title: string): Promise<Deck> {
    if (deckId !== null) {
      const deck = await port.findDeck(deckId);
      if (deck && deck.ownerId === user.id) return deck;
    }
    return personalDeck(user, title);
  }

  return {
    personalDeck,
    resolveDeck,

    /**
     * First half of `/add`: duplicate check, then ask for the translation.
     * `personalTitle` is the localized «Мои слова · EN» used if the deck is missing.
     */
    async preview(input: {
      user: User;
      text: string;
      deckId?: number | null;
      personalTitle: string;
      now: Date;
      /** Let the LLM fill the card in when it is configured and within budget. */
      generate?: boolean;
    }): Promise<AddPreview> {
      const front = normalizeFront(input.text);
      // Duplicates are checked on the typed word before anything is generated:
      // a word the user already has must never cost a model call.
      const duplicate = await duplicateOf(input.user, front);
      if (duplicate) {
        return { kind: "duplicate", duplicate, own: duplicate.deckOwnerId === input.user.id };
      }
      const check = await limits.canAddNotes(input.user, 1, input.now);
      if (!check.allowed) return { kind: "limit", check };
      const deck = await resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      if (!input.generate || !llm) return { kind: "ask_translation", front, deck };
      const budget = await limits.canGenerate(input.user, input.now);
      if (!budget.allowed) return { kind: "ask_translation", front, deck, reason: "limit" };
      return { kind: "generate", front, deck };
    },

    /**
     * Second step of §4.1a: ask the model, then re-check duplicates whenever the
     * canonical headword differs from what the user typed — that is the reverse
     * direction («неохотный» → "reluctant") and any typo or inflection fix.
     */
    async generate(input: { user: User; text: string; now: Date }): Promise<GenerateResult> {
      if (!llm) return { kind: "failed", reason: "unavailable" };
      const { langFrom, langTo } = pair(input.user);
      const started = Date.now();
      let card: GeneratedCard;
      let cached: boolean;
      try {
        const result = await llm.generator.generateWithMeta({ text: input.text, langFrom, langTo });
        card = result.card;
        cached = result.cached;
      } catch (error) {
        const reason = error instanceof GenerationError ? error.reason : "unavailable";
        return { kind: "failed", reason };
      }
      const latencyMs = Date.now() - started;
      if (normalizeCacheText(card.front) !== normalizeCacheText(input.text)) {
        const duplicate = await duplicateOf(input.user, card.front);
        if (duplicate) {
          return {
            kind: "duplicate",
            duplicate,
            own: duplicate.deckOwnerId === input.user.id,
            front: card.front,
            card,
          };
        }
      }
      return { kind: "generated", card, cached, latencyMs, reverse: card.detectedLang === langTo };
    },

    /**
     * «✨ Дополнить» and the background pass after a manual `word - перевод`:
     * fills the transcription and the example, never the translation. Returns
     * null when generation is off or failed — the caller ignores that.
     */
    async enrich(input: {
      user: User;
      noteId: number;
      front: string;
      now: Date;
    }): Promise<EnrichResult | null> {
      if (!llm) return null;
      // Filling a card in is an AI generation like any other (SPEC §9.1).
      if (!(await limits.canGenerate(input.user, input.now)).allowed) return null;
      const { langFrom, langTo } = pair(input.user);
      const started = Date.now();
      let card: GeneratedCard;
      let cached: boolean;
      try {
        const result = await llm.generator.generateWithMeta({
          text: input.front,
          langFrom,
          langTo,
        });
        card = result.card;
        cached = result.cached;
      } catch {
        return null;
      }
      const latencyMs = Date.now() - started;
      const empty: EnrichResult = { filled: false, cached, latencyMs, note: null };
      // The note keeps its own front. If the model answered about a different
      // word (the front is in the native language), its example is useless here.
      if (
        card.detectedLang === langTo &&
        normalizeCacheText(card.front) !== normalizeCacheText(input.front)
      ) {
        return empty;
      }
      if (!card.transcription && !card.example) return empty;
      const note = await port.fillNote(input.noteId, {
        ...(card.transcription ? { transcription: card.transcription } : {}),
        ...(card.example ? { example: card.example, exampleTr: card.exampleTr } : {}),
      });
      return { filled: note !== null, cached, latencyMs, note };
    },

    /** Second half: the translation arrived (or came inline as `word - перевод`). */
    async save(input: {
      user: User;
      front: string;
      back: string;
      deckId?: number | null;
      personalTitle: string;
      now: Date;
      /** Filled in by §4.1a; a manual card leaves them empty. */
      transcription?: string;
      example?: string;
      exampleTr?: string;
      /** «➕ Добавить всё равно»: the user has seen the duplicate and wants it. */
      force?: boolean;
    }): Promise<SaveResult> {
      const front = normalizeFront(input.front);
      const back = normalizeFront(input.back);
      const duplicate = input.force ? undefined : await duplicateOf(input.user, front);
      if (duplicate) return { kind: "duplicate", duplicate };
      const check = await limits.canAddNotes(input.user, 1, input.now);
      if (!check.allowed) return { kind: "limit", check };
      const deck = await resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      const note = await port.createNote({
        deckId: deck.id,
        front,
        back,
        transcription: input.transcription?.trim() || null,
        example: input.example?.trim() || null,
        exampleTr: input.exampleTr?.trim() || null,
      });
      return { kind: "added", deck, note };
    },

    /** Multi-line paste: everything that is not already known gets added at once. */
    async saveMany(input: {
      user: User;
      pairs: ReadonlyArray<ParsedPair>;
      invalid?: number;
      deckId?: number | null;
      personalTitle: string;
      now: Date;
    }): Promise<BulkResult> {
      const existing = await port.findDuplicates({
        userId: input.user.id,
        fronts: input.pairs.map((pair) => pair.front),
      });
      const known = new Set(existing.map((note) => note.front.toLowerCase()));
      const fresh = input.pairs.filter((pair) => !known.has(pair.front.toLowerCase()));
      const check = await limits.canAddNotes(input.user, fresh.length, input.now);
      if (!check.allowed) return { kind: "limit", check };
      const deck = await resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      const added = fresh.length > 0 ? await port.createNotes(deck.id, fresh) : 0;
      return {
        kind: "added",
        deck,
        added,
        skipped: input.pairs.length - added,
        invalid: input.invalid ?? 0,
      };
    },

    listOwnDecks: (userId: number) => port.listOwnDecks(userId),

    /** null when `OPENROUTER_API_KEY` is unset: the bot then stays on §4.1. */
    llm,
  };
}

export type AddService = ReturnType<typeof createAddService>;

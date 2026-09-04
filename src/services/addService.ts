import type { DuplicateNote } from "../db/repos/notes.js";
import type { Deck, Note, User } from "../db/schema.js";
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
  createNote(input: { deckId: number; front: string; back: string }): Promise<Note>;
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

export type AddPreview =
  | { kind: "duplicate"; duplicate: DuplicateNote; own: boolean }
  | { kind: "ask_translation"; front: string; deck: Deck }
  | { kind: "limit"; check: LimitCheck };

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

export function createAddService(port: AddPort, limits: Limits) {
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
    }): Promise<AddPreview> {
      const front = normalizeFront(input.text);
      const duplicate = pickDuplicate(
        await port.findDuplicates({ userId: input.user.id, fronts: [front] }),
        input.user.id,
      );
      if (duplicate) {
        return { kind: "duplicate", duplicate, own: duplicate.deckOwnerId === input.user.id };
      }
      const check = await limits.canAddNotes(input.user, 1, input.now);
      if (!check.allowed) return { kind: "limit", check };
      const deck = await resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      return { kind: "ask_translation", front, deck };
    },

    /** Second half: the translation arrived (or came inline as `word - перевод`). */
    async save(input: {
      user: User;
      front: string;
      back: string;
      deckId?: number | null;
      personalTitle: string;
      now: Date;
    }): Promise<SaveResult> {
      const front = normalizeFront(input.front);
      const back = normalizeFront(input.back);
      const duplicate = pickDuplicate(
        await port.findDuplicates({ userId: input.user.id, fronts: [front] }),
        input.user.id,
      );
      if (duplicate) return { kind: "duplicate", duplicate };
      const check = await limits.canAddNotes(input.user, 1, input.now);
      if (!check.allowed) return { kind: "limit", check };
      const deck = await resolveDeck(input.user, input.deckId ?? null, input.personalTitle);
      const note = await port.createNote({ deckId: deck.id, front, back });
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
  };
}

export type AddService = ReturnType<typeof createAddService>;

import { beforeEach, describe, expect, it } from "vitest";
import type { DuplicateNote } from "../src/db/repos/notes.js";
import type { Deck, Note } from "../src/db/schema.js";
import {
  type AddPort,
  createAddService,
  isAddCandidate,
  normalizeFront,
  parsePair,
  parsePairs,
} from "../src/services/addService.js";
import { createLimits, FREE_LIMITS } from "../src/services/limits.js";
import { makeUser } from "./helpers/fakeSession.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const PERSONAL = "Мои слова · EN";

describe("text parsing", () => {
  it("normalizes whitespace but keeps the case", () => {
    expect(normalizeFront("  der   Tisch ")).toBe("der Tisch");
    expect(normalizeFront("iPhone")).toBe("iPhone");
  });

  it("splits pairs on hyphen, em dash, en dash and tab", () => {
    expect(parsePair("reluctant - неохотный")).toEqual({
      front: "reluctant",
      back: "неохотный",
    });
    expect(parsePair("reluctant — неохотный")?.back).toBe("неохотный");
    expect(parsePair("reluctant – неохотный")?.back).toBe("неохотный");
    expect(parsePair("reluctant\tнеохотный")?.back).toBe("неохотный");
  });

  it("leaves hyphenated words alone", () => {
    expect(parsePair("well-known")).toBeNull();
    expect(parsePair("- неохотный")).toBeNull();
    expect(parsePair("reluctant -")).toBeNull();
  });

  it("parses a multi-line paste and drops duplicates inside it", () => {
    const parsed = parsePairs("a - б\nc — д\nмусор\nA - в");
    expect(parsed.pairs).toEqual([
      { front: "a", back: "б" },
      { front: "c", back: "д" },
    ]);
    expect(parsed.invalid).toBe(1);
    expect(parsed.bulk).toBe(true);
  });

  it("caps a paste at 100 lines", () => {
    const many = Array.from({ length: 150 }, (_, i) => `w${i} - п${i}`).join("\n");
    expect(parsePairs(many).pairs).toHaveLength(100);
  });

  it("recognizes what counts as a word to add", () => {
    expect(isAddCandidate("reluctant")).toBe(true);
    expect(isAddCandidate("look forward to")).toBe(true);
    expect(isAddCandidate("это уже четыре слова тут")).toBe(false);
    expect(isAddCandidate("x".repeat(41))).toBe(false);
    expect(isAddCandidate("/start")).toBe(false);
    expect(isAddCandidate("   ")).toBe(false);
  });
});

interface FakeAdd {
  port: AddPort;
  notes: Note[];
  decks: Deck[];
  duplicates: DuplicateNote[];
  ownNotes: number;
  ownDecks: number;
}

function makeDeck(id: number, ownerId: number | null, title: string): Deck {
  return {
    id,
    ownerId,
    slug: ownerId === null ? `deck-${id}` : null,
    title,
    description: null,
    langFrom: "en",
    langTo: "ru",
    kind: ownerId === null ? "builtin" : "user",
    level: null,
    isPublic: ownerId === null,
    publicId: null,
    createdAt: NOW,
  };
}

function fakeAdd(): FakeAdd {
  const state = {
    notes: [] as Note[],
    decks: [] as Deck[],
    duplicates: [] as DuplicateNote[],
    ownNotes: 0,
    ownDecks: 0,
  };
  let nextNoteId = 1;
  let nextDeckId = 10;
  const port: AddPort = {
    async findDuplicates({ fronts }) {
      const wanted = new Set(fronts.map((front) => front.toLowerCase()));
      return state.duplicates.filter((note) => wanted.has(note.front.toLowerCase()));
    },
    async createNote({ deckId, front, back }) {
      const note: Note = {
        id: nextNoteId++,
        deckId,
        front,
        back,
        transcription: null,
        example: null,
        exampleTr: null,
        audioFileId: null,
        imageFileId: null,
        tags: [],
        position: state.notes.length,
        createdAt: NOW,
      };
      state.notes.push(note);
      return note;
    },
    async createNotes(deckId, pairs) {
      for (const pair of pairs) await port.createNote({ deckId, ...pair });
      return pairs.length;
    },
    async findPersonalDeck(ownerId) {
      return state.decks.find((deck) => deck.ownerId === ownerId) ?? null;
    },
    async createUserDeck({ ownerId, title, langFrom, langTo }) {
      const deck = { ...makeDeck(nextDeckId++, ownerId, title), langFrom, langTo };
      state.decks.push(deck);
      return deck;
    },
    async subscribe() {},
    async findDeck(id) {
      return state.decks.find((deck) => deck.id === id) ?? null;
    },
    async listOwnDecks(ownerId) {
      return state.decks.filter((deck) => deck.ownerId === ownerId);
    },
  };
  return { port, ...state };
}

function service(fake: FakeAdd, proEnabled = false) {
  const limits = createLimits(
    {
      countOwnDecks: async () => fake.ownDecks,
      countOwnNotes: async () => fake.ownNotes,
    },
    { proEnabled },
  );
  return createAddService(fake.port, limits);
}

describe("add service", () => {
  const user = makeUser();
  let fake: FakeAdd;

  beforeEach(() => {
    fake = fakeAdd();
  });

  it("asks for a translation and creates the personal deck on the way", async () => {
    const preview = await service(fake).preview({
      user,
      text: "  reluctant ",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("ask_translation");
    if (preview.kind !== "ask_translation") return;
    expect(preview.front).toBe("reluctant");
    expect(preview.deck.title).toBe(PERSONAL);
    expect(fake.decks).toHaveLength(1);
  });

  it("saves the note once the translation arrives", async () => {
    const result = await service(fake).save({
      user,
      front: "reluctant",
      back: "  неохотный,  сопротивляющийся ",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    expect(result.note).toMatchObject({
      front: "reluctant",
      back: "неохотный, сопротивляющийся",
      transcription: null,
      example: null,
    });
    expect(result.deck.title).toBe(PERSONAL);
  });

  it("reports a duplicate in the user's own deck", async () => {
    fake.duplicates.push({
      noteId: 7,
      deckId: 10,
      deckTitle: PERSONAL,
      deckOwnerId: user.id,
      front: "reluctant",
      back: "неохотный",
      position: 4,
    });
    const preview = await service(fake).preview({
      user,
      text: "Reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("duplicate");
    if (preview.kind !== "duplicate") return;
    expect(preview.own).toBe(true);
    expect(preview.duplicate.deckTitle).toBe(PERSONAL);
  });

  it("points at the builtin deck and position when the word is already there", async () => {
    fake.duplicates.push({
      noteId: 9,
      deckId: 1,
      deckTitle: "English Top 1000 · A2",
      deckOwnerId: null,
      front: "reluctant",
      back: "неохотный",
      position: 214,
    });
    const preview = await service(fake).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (preview.kind !== "duplicate") throw new Error("expected a duplicate");
    expect(preview.own).toBe(false);
    expect(preview.duplicate.position).toBe(214);
  });

  it("refuses to save a duplicate that appeared between the two steps", async () => {
    fake.duplicates.push({
      noteId: 9,
      deckId: 1,
      deckTitle: "English Top 1000 · A2",
      deckOwnerId: null,
      front: "reluctant",
      back: "неохотный",
      position: 214,
    });
    const result = await service(fake).save({
      user,
      front: "reluctant",
      back: "мой перевод",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(result.kind).toBe("duplicate");
    expect(fake.notes).toHaveLength(0);
  });

  it("prefers the user's own deck when the word sits in several", async () => {
    fake.duplicates.push(
      {
        noteId: 9,
        deckId: 1,
        deckTitle: "English Top 1000 · A2",
        deckOwnerId: null,
        front: "reluctant",
        back: "неохотный",
        position: 214,
      },
      {
        noteId: 12,
        deckId: 10,
        deckTitle: PERSONAL,
        deckOwnerId: user.id,
        front: "reluctant",
        back: "мой перевод",
        position: 2,
      },
    );
    const preview = await service(fake).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (preview.kind !== "duplicate") throw new Error("expected a duplicate");
    expect(preview.own).toBe(true);
    expect(preview.duplicate.deckTitle).toBe(PERSONAL);
  });

  it("bulk-adds a paste and counts the duplicates it skipped", async () => {
    fake.duplicates.push({
      noteId: 9,
      deckId: 1,
      deckTitle: "English Top 1000 · A2",
      deckOwnerId: null,
      front: "cat",
      back: "кот",
      position: 3,
    });
    const parsed = parsePairs("cat - кошка\ndog - собака\nfish - рыба\nмусор");
    const result = await service(fake).saveMany({
      user,
      pairs: parsed.pairs,
      invalid: parsed.invalid,
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(1);
    expect(fake.notes.map((note) => note.front)).toEqual(["dog", "fish"]);
  });

  it("writes into an explicitly chosen own deck", async () => {
    const other = await fake.port.createUserDeck({
      ownerId: user.id,
      title: "Идиомы",
      langFrom: "en",
      langTo: "ru",
    });
    const result = await service(fake).save({
      user,
      front: "kick the bucket",
      back: "умереть",
      deckId: other.id,
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.deck.id).toBe(other.id);
  });

  it("ignores a deck that belongs to someone else", async () => {
    fake.decks.push(makeDeck(99, 42, "Чужая дека"));
    const result = await service(fake).save({
      user,
      front: "word",
      back: "слово",
      deckId: 99,
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.deck.title).toBe(PERSONAL);
  });
});

describe("free-plan gating", () => {
  const user = makeUser();

  it("allows everything while PRO_ENABLED is off", async () => {
    const fake = fakeAdd();
    fake.ownNotes = FREE_LIMITS.ownNotes + 100;
    const preview = await service(fake, false).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("ask_translation");
  });

  it("blocks the note budget once PRO_ENABLED is on", async () => {
    const fake = fakeAdd();
    fake.ownNotes = FREE_LIMITS.ownNotes;
    const preview = await service(fake, true).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("limit");
    if (preview.kind !== "limit") return;
    expect(preview.check.limit).toBe(FREE_LIMITS.ownNotes);
  });

  it("blocks a bulk paste that would overflow the budget", async () => {
    const fake = fakeAdd();
    fake.ownNotes = FREE_LIMITS.ownNotes - 1;
    const result = await service(fake, true).saveMany({
      user,
      pairs: [
        { front: "a", back: "б" },
        { front: "c", back: "д" },
      ],
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(result.kind).toBe("limit");
    expect(fake.notes).toHaveLength(0);
  });

  it("lets Pro users past the budget", async () => {
    const fake = fakeAdd();
    fake.ownNotes = FREE_LIMITS.ownNotes + 500;
    const pro = makeUser({ plan: "pro", planUntil: new Date("2027-01-01T00:00:00.000Z") });
    const preview = await service(fake, true).preview({
      user: pro,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("ask_translation");
  });
});

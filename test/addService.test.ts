import { beforeEach, describe, expect, it } from "vitest";
import type { DuplicateNote } from "../src/db/repos/notes.js";
import type { Deck, Note } from "../src/db/schema.js";
import type { CachedCardGenerator } from "../src/llm/cache.js";
import { type GenerateCardInput, type GeneratedCard, GenerationError } from "../src/llm/types.js";
import {
  type AddPort,
  createAddService,
  isAddCandidate,
  type LlmSupport,
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
  /** Uncached generations already made today (what §9.1 counts). */
  generations: number;
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
    generations: 0,
  };
  let nextNoteId = 1;
  let nextDeckId = 10;
  const port: AddPort = {
    async findDuplicates({ fronts }) {
      const wanted = new Set(fronts.map((front) => front.toLowerCase()));
      return state.duplicates.filter((note) => wanted.has(note.front.toLowerCase()));
    },
    async createNote({ deckId, front, back, transcription, example, exampleTr }) {
      const note: Note = {
        id: nextNoteId++,
        deckId,
        front,
        back,
        transcription: transcription ?? null,
        example: example ?? null,
        exampleTr: exampleTr ?? null,
        audioFileId: null,
        imageFileId: null,
        tags: [],
        position: state.notes.length,
        createdAt: NOW,
      };
      state.notes.push(note);
      return note;
    },
    async fillNote(noteId, values) {
      const note = state.notes.find((row) => row.id === noteId);
      if (!note) return null;
      if (values.transcription && !note.transcription) note.transcription = values.transcription;
      if (values.example && !note.example) {
        note.example = values.example;
        note.exampleTr = values.exampleTr ?? null;
      }
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

function service(fake: FakeAdd, proEnabled = false, llm: LlmSupport | null = null) {
  const limits = createLimits(
    {
      countOwnDecks: async () => fake.ownDecks,
      countOwnNotes: async () => fake.ownNotes,
      countGenerationsSince: async () => fake.generations,
    },
    { proEnabled },
  );
  return createAddService(fake.port, limits, llm);
}

const CARD: GeneratedCard = {
  front: "reluctant",
  back: "неохотный, сопротивляющийся",
  transcription: "rɪˈlʌktənt",
  example: "She was reluctant to go.",
  exampleTr: "Она не хотела идти.",
  pos: "adjective",
  detectedLang: "en",
};

interface FakeLlm extends LlmSupport {
  calls: GenerateCardInput[];
}

/** A generator that answers from a script; `cached` mimics a `generated_cache` hit. */
function fakeLlm(
  reply: GeneratedCard | Error | ((input: GenerateCardInput) => GeneratedCard),
  options: { cached?: boolean } = {},
): FakeLlm {
  const calls: GenerateCardInput[] = [];
  const generateWithMeta = async (input: GenerateCardInput) => {
    calls.push(input);
    if (reply instanceof Error) throw reply;
    const card = typeof reply === "function" ? reply(input) : reply;
    return { card, cached: options.cached ?? false };
  };
  const generator: CachedCardGenerator = {
    generateWithMeta,
    generate: async (input) => (await generateWithMeta(input)).card,
  };
  return { model: "test/model", generator, calls };
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

describe("AI card generation (SPEC §4.1a)", () => {
  const user = makeUser();
  let fake: FakeAdd;

  beforeEach(() => {
    fake = fakeAdd();
  });

  it("offers generation only when a generator is configured", async () => {
    const withoutLlm = await service(fake).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(withoutLlm.kind).toBe("ask_translation");

    const withLlm = await service(fake, false, fakeLlm(CARD)).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(withLlm.kind).toBe("generate");
    if (withLlm.kind !== "generate") return;
    expect(withLlm.front).toBe("reluctant");
    expect(withLlm.deck.title).toBe(PERSONAL);
  });

  it("keeps the manual flow when the caller does not ask for generation", async () => {
    const preview = await service(fake, false, fakeLlm(CARD)).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
    });
    expect(preview.kind).toBe("ask_translation");
  });

  it("never spends a model call on a word the user already has", async () => {
    fake.duplicates.push({
      noteId: 7,
      deckId: 10,
      deckTitle: PERSONAL,
      deckOwnerId: user.id,
      front: "reluctant",
      back: "неохотный",
      position: 4,
    });
    const llm = fakeLlm(CARD);
    const preview = await service(fake, false, llm).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("duplicate");
    expect(llm.calls).toHaveLength(0);
  });

  it("generates a card and reports the direction and the cache flag", async () => {
    const llm = fakeLlm(CARD);
    const result = await service(fake, false, llm).generate({ user, text: "reluctant", now: NOW });
    expect(llm.calls[0]).toEqual({ text: "reluctant", langFrom: "en", langTo: "ru" });
    expect(result.kind).toBe("generated");
    if (result.kind !== "generated") return;
    expect(result.card.front).toBe("reluctant");
    expect(result.cached).toBe(false);
    expect(result.reverse).toBe(false);
  });

  it("marks the reverse direction when the user typed their own language", async () => {
    const llm = fakeLlm({ ...CARD, detectedLang: "ru" });
    const result = await service(fake, false, llm).generate({ user, text: "неохотный", now: NOW });
    if (result.kind !== "generated") throw new Error("expected a generated card");
    expect(result.reverse).toBe(true);
    expect(result.card.front).toBe("reluctant");
  });

  it("re-checks duplicates on the generated headword", async () => {
    fake.duplicates.push({
      noteId: 9,
      deckId: 1,
      deckTitle: "English Top 1000 · A2",
      deckOwnerId: null,
      front: "reluctant",
      back: "неохотный",
      position: 214,
    });
    const llm = fakeLlm({ ...CARD, detectedLang: "ru" });
    const result = await service(fake, false, llm).generate({ user, text: "неохотный", now: NOW });
    expect(result.kind).toBe("duplicate");
    if (result.kind !== "duplicate") return;
    expect(result.own).toBe(false);
    expect(result.front).toBe("reluctant");
    // The card comes with it: «Добавить всё равно» shows it instead of asking
    // for a translation the model has already produced.
    expect(result.card.back).toBe(CARD.back);
    expect(llm.calls).toHaveLength(1);
  });

  it("saves past the duplicate check once the user forced it", async () => {
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
      force: true,
    });
    expect(result.kind).toBe("added");
    expect(fake.notes).toHaveLength(1);
  });

  it("does not re-check duplicates when the headword is what the user typed", async () => {
    const llm = fakeLlm(CARD);
    const spy: string[][] = [];
    const original = fake.port.findDuplicates.bind(fake.port);
    fake.port.findDuplicates = async (input) => {
      spy.push(input.fronts);
      return original(input);
    };
    await service(fake, false, llm).generate({ user, text: "Reluctant ", now: NOW });
    expect(spy).toEqual([]);
  });

  it("maps a GenerationError onto its reason", async () => {
    const llm = fakeLlm(new GenerationError("too slow", "timeout"));
    const result = await service(fake, false, llm).generate({ user, text: "reluctant", now: NOW });
    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  it("treats an unexpected error as unavailable", async () => {
    const llm = fakeLlm(new Error("boom"));
    const result = await service(fake, false, llm).generate({ user, text: "reluctant", now: NOW });
    expect(result).toMatchObject({ kind: "failed", reason: "unavailable" });
  });

  it("fails cleanly when generation is switched off", async () => {
    const result = await service(fake).generate({ user, text: "reluctant", now: NOW });
    expect(result).toMatchObject({ kind: "failed", reason: "unavailable" });
  });

  it("stores the whole generated card, transcription and example included", async () => {
    const result = await service(fake, false, fakeLlm(CARD)).save({
      user,
      front: CARD.front,
      back: CARD.back,
      transcription: CARD.transcription,
      example: CARD.example,
      exampleTr: CARD.exampleTr,
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.note).toMatchObject({
      front: "reluctant",
      back: "неохотный, сопротивляющийся",
      transcription: "rɪˈlʌktənt",
      example: "She was reluctant to go.",
      exampleTr: "Она не хотела идти.",
    });
  });

  it("keeps the user's own translation while reusing the generated extras", async () => {
    const result = await service(fake, false, fakeLlm(CARD)).save({
      user,
      front: CARD.front,
      back: "упрямый",
      transcription: CARD.transcription,
      example: CARD.example,
      exampleTr: CARD.exampleTr,
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.note.back).toBe("упрямый");
    expect(result.note.transcription).toBe("rɪˈlʌktənt");
  });
});

describe("free generation budget (SPEC §9.1)", () => {
  const user = makeUser();
  let fake: FakeAdd;

  beforeEach(() => {
    fake = fakeAdd();
  });

  it("ignores the budget while PRO_ENABLED is off", async () => {
    fake.generations = FREE_LIMITS.generationsPerDay + 5;
    const preview = await service(fake, false, fakeLlm(CARD)).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("generate");
  });

  it("falls back to the manual question once the day's budget is spent", async () => {
    fake.generations = FREE_LIMITS.generationsPerDay;
    const llm = fakeLlm(CARD);
    const preview = await service(fake, true, llm).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("ask_translation");
    if (preview.kind !== "ask_translation") return;
    expect(preview.reason).toBe("limit");
    expect(llm.calls).toHaveLength(0);
  });

  it("still generates with one call left", async () => {
    fake.generations = FREE_LIMITS.generationsPerDay - 1;
    const preview = await service(fake, true, fakeLlm(CARD)).preview({
      user,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("generate");
  });

  it("does not count cache hits — the counter only sees uncached generations", async () => {
    const llm = fakeLlm(CARD, { cached: true });
    const result = await service(fake, true, llm).generate({ user, text: "reluctant", now: NOW });
    if (result.kind !== "generated") throw new Error("expected a generated card");
    expect(result.cached).toBe(true);
    // `fake.generations` is fed by `word_generated` events with `cached: false`,
    // so a hit leaves the budget untouched and the next preview still generates.
    const preview = await service(fake, true, llm).preview({
      user,
      text: "another",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("generate");
  });

  it("lets Pro users generate past the budget", async () => {
    fake.generations = 500;
    const pro = makeUser({ plan: "pro", planUntil: null });
    const preview = await service(fake, true, fakeLlm(CARD)).preview({
      user: pro,
      text: "reluctant",
      personalTitle: PERSONAL,
      now: NOW,
      generate: true,
    });
    expect(preview.kind).toBe("generate");
  });
});

describe("enriching a manual note", () => {
  const user = makeUser();
  let fake: FakeAdd;

  async function manualNote(llm: LlmSupport | null): Promise<Note> {
    const result = await service(fake, false, llm).save({
      user,
      front: "reluctant",
      back: "неохотный",
      personalTitle: PERSONAL,
      now: NOW,
    });
    if (result.kind !== "added") throw new Error("expected added");
    return result.note;
  }

  beforeEach(() => {
    fake = fakeAdd();
  });

  it("fills the transcription and the example of a manually typed pair", async () => {
    const llm = fakeLlm(CARD);
    const note = await manualNote(llm);
    const result = await service(fake, false, llm).enrich({
      user,
      noteId: note.id,
      front: note.front,
      now: NOW,
    });
    expect(result).toMatchObject({ filled: true, cached: false });
    expect(fake.notes[0]).toMatchObject({
      back: "неохотный",
      transcription: "rɪˈlʌktənt",
      example: "She was reluctant to go.",
      exampleTr: "Она не хотела идти.",
    });
  });

  it("never overwrites what the note already has", async () => {
    const llm = fakeLlm(CARD);
    const note = await manualNote(llm);
    fake.notes[0]!.example = "My own sentence.";
    await service(fake, false, llm).enrich({ user, noteId: note.id, front: note.front, now: NOW });
    expect(fake.notes[0]?.example).toBe("My own sentence.");
    expect(fake.notes[0]?.transcription).toBe("rɪˈlʌktənt");
  });

  it("does nothing when the model answered about a different word", async () => {
    const llm = fakeLlm({ ...CARD, front: "eager", detectedLang: "ru" });
    const note = await manualNote(llm);
    const result = await service(fake, false, llm).enrich({
      user,
      noteId: note.id,
      front: note.front,
      now: NOW,
    });
    expect(result).toMatchObject({ filled: false });
    expect(fake.notes[0]?.example).toBeNull();
  });

  it("returns null when generation is off or fails", async () => {
    const note = await manualNote(null);
    expect(
      await service(fake).enrich({ user, noteId: note.id, front: note.front, now: NOW }),
    ).toBeNull();
    const broken = fakeLlm(new GenerationError("down", "unavailable"));
    expect(
      await service(fake, false, broken).enrich({
        user,
        noteId: note.id,
        front: note.front,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("respects the daily budget", async () => {
    fake.generations = FREE_LIMITS.generationsPerDay;
    const llm = fakeLlm(CARD);
    const note = await manualNote(llm);
    expect(
      await service(fake, true, llm).enrich({ user, noteId: note.id, front: note.front, now: NOW }),
    ).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});

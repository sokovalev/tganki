/**
 * End-to-end routing of the add flow (SPEC §4.1, §4.1a, §11): what a text
 * message does in every pending state, and what the buttons on a duplicate
 * screen do. These are the paths that broke in live testing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ADD_BACK, ADD_WORD } from "../src/bot/add.js";
import type { GeneratedCard } from "../src/llm/types.js";
import { createFakeBot, duplicateNote, type FakeBot, makeDeck } from "./helpers/fakeBot.js";

const CARD: GeneratedCard = {
  front: "კითხვა",
  back: "чтение, вопрос",
  transcription: "kitxva",
  example: "წიგნის კითხვა მიყვარს.",
  exampleTr: "Я люблю читать книги.",
  pos: "noun",
  detectedLang: "ka",
};

describe("«➕ Добавить всё равно» after a duplicate (SPEC §4.1)", () => {
  it("shows the generated card instead of asking for a translation again", async () => {
    // The user typed a conjugated form; the model canonicalized it into a word
    // that is already in a builtin deck.
    const bot = createFakeBot({ card: CARD, duplicates: [duplicateNote()] });
    await bot.text("ვკითხულობ");
    expect(bot.lastText()).toContain("Есть в «Грузинский Top 500 · A1»");
    expect(bot.lastButtons()).toEqual(["a:now:7", "a:force"]);
    // The card is parked, not thrown away.
    expect(bot.user().pendingPayload?.card?.front).toBe("კითხვა");
    expect(bot.user().pendingInput).toBeNull();

    await bot.tap("a:force");
    expect(bot.lastText()).toContain("чтение, вопрос");
    expect(bot.lastButtons()).toEqual(["a:g", "a:decks", "a:own", "a:cancel"]);
    expect(bot.lastText()).not.toContain("Перевод для");
  });

  it("saves the forced card past the duplicate check", async () => {
    const bot = createFakeBot({ card: CARD, duplicates: [duplicateNote()] });
    await bot.text("ვკითხულობ");
    await bot.tap("a:force");
    await bot.tap("a:g");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "კითხვა", back: "чтение, вопрос" });
    expect(bot.lastText()).toContain("Добавил");
  });

  it("generates the card when the duplicate was found on the typed word", async () => {
    // Duplicate before generation: the model must not have been called yet.
    const bot = createFakeBot({
      card: CARD,
      duplicates: [duplicateNote({ front: "კითხვა", deckTitle: "Мои слова · KA", deckOwnerId: 1 })],
    });
    await bot.text("კითხვა");
    expect(bot.generations).toHaveLength(0);
    expect(bot.lastText()).toContain("Уже есть в «Мои слова · KA»");

    await bot.tap("a:force");
    expect(bot.generations).toHaveLength(1);
    expect(bot.lastText()).toContain("чтение, вопрос");
    expect(bot.lastButtons()).toContain("a:g");
  });

  it("falls back to the manual question when generation is off", async () => {
    const bot = createFakeBot({ card: null, duplicates: [duplicateNote()] });
    await bot.text("კითხვა");
    await bot.tap("a:force");
    expect(bot.lastText()).toContain("Перевод для «კითხვა»?");
    expect(bot.user().pendingInput).toBe(ADD_BACK);

    await bot.text("чтение");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "კითხვა", back: "чтение" });
  });

  it("keeps a typed pair as the draft so it can still be forced", async () => {
    const bot = createFakeBot({ card: null, duplicates: [duplicateNote()] });
    await bot.text("კითხვა - чтение");
    expect(bot.notes()).toHaveLength(0);
    expect(bot.lastButtons()).toContain("a:force");

    await bot.tap("a:force");
    expect(bot.lastText()).toContain("чтение");
    await bot.tap("a:g");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "კითხვა", back: "чтение" });
  });

  it("says the word got lost when nothing is parked any more", async () => {
    const bot = createFakeBot({ card: CARD });
    await bot.tap("a:force");
    expect(bot.lastText()).toContain("Слово потерялось");
  });
});

describe("the duplicate screen (SPEC §4.1)", () => {
  it("names the deck and the translation, without the position", async () => {
    const bot = createFakeBot({ card: null, duplicates: [duplicateNote()] });
    await bot.text("კითხვა");
    expect(bot.lastText()).toBe("Есть в «Грузинский Top 500 · A1»: კითხვა — чтение.");
    expect(bot.lastText()).not.toContain("74");
  });
});

describe("free text is always a new word (SPEC §11)", () => {
  let bot: FakeBot;

  beforeEach(() => {
    bot = createFakeBot({ card: CARD, duplicates: [duplicateNote({ front: "გამარჯობა" })] });
  });

  it("never answers a message with «Ок, ничего не добавляю»", async () => {
    // The sequence from the bug report: two duplicate screens nobody tapped,
    // then more text.
    await bot.text("გამარჯობა");
    expect(bot.lastText()).toContain("Есть в");
    await bot.text("სახლში ვარ");
    await bot.text("asdfgh");
    expect(bot.texts()).not.toContain("Ок, ничего не добавляю.");
    expect(bot.texts().some((text) => text.includes("Ок, ничего не добавляю"))).toBe(false);
  });

  it("does not treat the text after a duplicate screen as an answer", async () => {
    await bot.text("გამარჯობა");
    expect(bot.user().pendingInput).toBeNull();
    await bot.text("სახლში ვარ");
    // A card preview for the new word, not a note saved with front = back.
    expect(bot.notes()).toHaveLength(0);
    // «გამარჯობა» is already known, so it never reached the model; the new
    // word did, as a word of its own.
    expect(bot.generations.map((call) => call.text)).toEqual(["სახლში ვარ"]);
    expect(bot.lastButtons()).toContain("a:g");
  });

  it("saves a pair sent after a duplicate screen instead of opening a picker", async () => {
    await bot.text("გამარჯობა");
    await bot.text("ხინკალი - хинкали");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "ხინკალი", back: "хинкали" });
    expect(bot.lastText()).toContain("Добавил");
  });

  it("drops a pending state nobody owns and adds the word", async () => {
    bot.setUser({
      pendingInput: "some_old_state",
      pendingInputExpiresAt: new Date("2026-01-10T12:05:00.000Z"),
      pendingPayload: { front: "старое", deckId: 42 },
    });
    await bot.text("asdfgh");
    expect(bot.user().pendingInput).toBeNull();
    expect(bot.generations.map((call) => call.text)).toEqual(["asdfgh"]);
    expect(bot.lastButtons()).toContain("a:g");
  });

  it("ignores the deck of an expired draft", async () => {
    const personal = makeDeck(10, 1, "Мои слова · KA");
    const other = makeDeck(77, 1, "Идиомы");
    const withDeck = createFakeBot({ card: CARD, decks: [personal, other] });
    withDeck.setUser({
      pendingInput: ADD_BACK,
      // Expired ten minutes ago: the draft is gone, the deck with it.
      pendingInputExpiresAt: new Date("2026-01-10T11:50:00.000Z"),
      pendingPayload: { front: "старое", deckId: 77 },
    });
    await withDeck.text("კითხვა - чтение");
    expect(withDeck.notes()[0]?.deckId).toBe(10);
  });

  it("keeps the chosen deck while the word prompt is pending", async () => {
    const personal = makeDeck(10, 1, "Мои слова · KA");
    const other = makeDeck(77, 1, "Идиомы");
    const withDeck = createFakeBot({ card: CARD, decks: [personal, other] });
    withDeck.setUser({
      pendingInput: ADD_WORD,
      pendingInputExpiresAt: new Date("2026-01-10T12:05:00.000Z"),
      pendingPayload: { deckId: 77 },
    });
    await withDeck.text("კითხვა - чтение");
    expect(withDeck.notes()[0]?.deckId).toBe(77);
  });
});

describe("the manual question (SPEC §4.1)", () => {
  it("takes a pair as a new word, the way its own hint promises", async () => {
    const bot = createFakeBot({ card: null });
    await bot.text("კითხვა");
    expect(bot.user().pendingInput).toBe(ADD_BACK);
    await bot.text("ხინკალი - хинкали");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "ხინკალი", back: "хинкали" });
    expect(bot.user().pendingInput).toBeNull();
  });

  it("still saves a plain translation for the word it asked about", async () => {
    const bot = createFakeBot({ card: null });
    await bot.text("კითხვა");
    await bot.text("чтение");
    expect(bot.notes()[0]).toMatchObject({ front: "კითხვა", back: "чтение" });
  });
});

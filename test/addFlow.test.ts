/**
 * End-to-end routing of the add flow (SPEC §4.1, §4.1a, §11): what a text
 * message does in every pending state, and what the buttons on a duplicate
 * screen do. These are the paths that broke in live testing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ADD_BACK, ADD_WORD } from "../src/bot/add.js";
import type { ExtractedWords, GeneratedCard } from "../src/llm/types.js";
import { FREE_LIMITS } from "../src/services/limits.js";
import { createFakeBot, duplicateNote, type FakeBot, makeDeck, NOW } from "./helpers/fakeBot.js";

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
    expect(bot.lastButtons()).toEqual(["a:now:1:7", "a:force:1"]);
    // The card is parked, not thrown away.
    expect(bot.user().pendingPayload?.card?.front).toBe("კითხვა");
    expect(bot.user().pendingInput).toBeNull();

    await bot.tap("a:force:1");
    expect(bot.lastText()).toContain("чтение, вопрос");
    expect(bot.lastButtons()).toEqual(["a:g:1", "a:decks:1", "a:own:1", "a:cancel:1"]);
    expect(bot.lastText()).not.toContain("Перевод для");
  });

  it("saves the forced card past the duplicate check", async () => {
    const bot = createFakeBot({ card: CARD, duplicates: [duplicateNote()] });
    await bot.text("ვკითხულობ");
    await bot.tap("a:force:1");
    await bot.tap("a:g:1");
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

    await bot.tap("a:force:1");
    expect(bot.generations).toHaveLength(1);
    expect(bot.lastText()).toContain("чтение, вопрос");
    expect(bot.lastButtons()).toContain("a:g:1");
  });

  it("falls back to the manual question when generation is off", async () => {
    const bot = createFakeBot({ card: null, duplicates: [duplicateNote()] });
    await bot.text("კითხვა");
    await bot.tap("a:force:1");
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
    expect(bot.lastButtons()).toContain("a:force:1");

    await bot.tap("a:force:1");
    expect(bot.lastText()).toContain("чтение");
    await bot.tap("a:g:1");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "კითხვა", back: "чтение" });
  });

  it("tells the user the message is stale when nothing is parked any more", async () => {
    const bot = createFakeBot({ card: CARD });
    await bot.tap("a:force:1");
    expect(bot.toasts()).toEqual(["Это старое сообщение, отправь слово ещё раз"]);
    expect(bot.notes()).toHaveLength(0);
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
    // Second draft of this chat, so the buttons carry revision 2.
    expect(bot.lastButtons()).toContain("a:g:2");
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
    expect(bot.lastButtons()).toContain("a:g:1");
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

describe("draft revisions (SPEC §4.1)", () => {
  const echo = (input: { text: string }): GeneratedCard => ({ ...CARD, front: input.text });

  it("ignores a button from an older draft and takes its keyboard away", async () => {
    const bot = createFakeBot({ card: echo });
    await bot.text("სახლი");
    expect(bot.lastButtons()).toContain("a:g:1");
    await bot.text("წიგნი");
    expect(bot.lastButtons()).toContain("a:g:2");

    // «➕ Добавить» on the first preview, which is two messages up by now.
    await bot.tap("a:g:1");
    expect(bot.notes()).toHaveLength(0);
    expect(bot.toasts()).toEqual(["Это старое сообщение, отправь слово ещё раз"]);
    const stripped = bot.calls.filter((call) => call.method === "editMessageReplyMarkup");
    expect(stripped).toHaveLength(1);
    expect(stripped[0]?.payload.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("still acts on the button of the draft that is current", async () => {
    const bot = createFakeBot({ card: echo });
    await bot.text("სახლი");
    await bot.text("წიგნი");
    await bot.tap("a:g:2");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.notes()[0]).toMatchObject({ front: "წიგნი" });
    expect(bot.toasts()).not.toContain("Это старое сообщение, отправь слово ещё раз");
  });

  it("keeps counting up after a draft is saved, so revisions never repeat", async () => {
    const bot = createFakeBot({ card: echo });
    await bot.text("სახლი");
    await bot.tap("a:g:1");
    expect(bot.notes()).toHaveLength(1);
    // The saved draft is gone but its number is not reused.
    await bot.text("წიგნი");
    expect(bot.lastButtons()).toContain("a:g:2");
    await bot.tap("a:g:1");
    expect(bot.notes()).toHaveLength(1);
    expect(bot.toasts()).toContain("Это старое сообщение, отправь слово ещё раз");
  });

  it("refuses a stale ✖ instead of cancelling the current draft", async () => {
    const bot = createFakeBot({ card: echo });
    await bot.text("სახლი");
    await bot.text("წიგნი");
    await bot.tap("a:cancel:1");
    expect(bot.user().pendingPayload?.card?.front).toBe("წიგნი");
    expect(bot.texts().some((text) => text.includes("Ок, ничего не добавляю"))).toBe(false);
  });
});

describe("words from a text (SPEC §4.3)", () => {
  const TEXT = "დღეს ბაზარში წავედი და ხილი ვიყიდე, გამყიდველი ძალიან თავაზიანი იყო.";
  /** A builtin deck the user is subscribed to but has not reached yet. */
  const TOP_500 = "Грузинский Top 500 · A1";

  const FOUND: ExtractedWords = {
    detectedLang: "ka",
    words: [
      { front: "ბაზარი", back: "рынок", inText: "ბაზარში" },
      { front: "ხილი", back: "фрукты", inText: "ხილი" },
    ],
  };

  /** A generator that answers about the very word it was asked about. */
  const filler = (input: { text: string }): GeneratedCard => ({
    ...CARD,
    front: input.text,
    back: "перевод от модели",
    transcription: `ipa-${input.text}`,
    example: "მაგალითი.",
    exampleTr: "Пример.",
  });

  function textBot(options: Partial<Parameters<typeof createFakeBot>[0]> = {}): FakeBot {
    return createFakeBot({ card: filler, extract: FOUND, ...options });
  }

  it("turns a long message into a checklist of unknown words", async () => {
    const bot = textBot();
    await bot.text(TEXT);
    expect(bot.texts()[0]).toBe("🔎 Ищу незнакомые слова…");
    expect(bot.lastText()).toContain("📝 Нашёл 2 слова");
    expect(bot.lastText()).toContain("1. <b>ბაზარი</b> — рынок");
    expect(bot.lastText()).toContain("2. <b>ხილი</b> — фрукты");
    expect(bot.lastText()).toContain("→ в деку «Мои слова · KA»");
    expect(bot.lastButtons()).toEqual([
      "x:t:1:0",
      "x:t:1:1",
      "x:add:1",
      "x:all:1",
      "x:none:1",
      "x:decks:1",
      "x:cancel:1",
    ]);
    expect(bot.lastLabels()).toContain("☑ 1");
    expect(bot.lastLabels()).toContain("✅ Добавить выбранные (2)");
    // The model is asked about the text, in the pair the user is learning.
    expect(bot.extractions).toEqual([{ text: TEXT, langFrom: "ka", langTo: "ru", level: "A2" }]);
    expect(bot.events.map((event) => event.name)).toContain("text_extracted");
    expect(bot.events.find((event) => event.name === "text_extracted")?.props).toMatchObject({
      words: 2,
      dropped: 0,
      model: "test/model",
      chars: TEXT.length,
    });
  });

  it("also reads a forwarded message, however short it is", async () => {
    const bot = textBot();
    await bot.forward("ბაზარი და ხილი");
    expect(bot.extractions).toHaveLength(1);
    expect(bot.lastText()).toContain("📝 Нашёл 2 слова");
  });

  it("ticks and unticks a line, keeping the same draft", async () => {
    const bot = textBot();
    await bot.text(TEXT);
    await bot.tap("x:t:1:0");
    expect(bot.lastLabels()).toEqual([
      "☐ 1",
      "☑ 2",
      "✅ Добавить выбранные (1)",
      "Выбрать все",
      "Снять все",
      "📚 Другая дека",
      "✖",
    ]);
    await bot.tap("x:none:1");
    expect(bot.lastLabels().slice(0, 3)).toEqual(["☐ 1", "☐ 2", "✅ Добавить выбранные (0)"]);
    await bot.tap("x:add:1");
    expect(bot.toasts()).toContain("Ничего не выбрано");
    expect(bot.notes()).toHaveLength(0);

    await bot.tap("x:all:1");
    expect(bot.lastLabels().slice(0, 3)).toEqual(["☑ 1", "☑ 2", "✅ Добавить выбранные (2)"]);
  });

  it("generates a card per ticked word and reports what it added", async () => {
    const bot = textBot();
    await bot.text(TEXT);
    await bot.tap("x:add:1");
    expect(bot.generations.map((call) => call.text)).toEqual(["ბაზარი", "ხილი"]);
    // The user approved «слово — перевод», so those two are saved as shown;
    // the model only fills the transcription and the example in.
    expect(bot.notes()).toHaveLength(2);
    expect(bot.notes()[0]).toMatchObject({
      front: "ბაზარი",
      back: "рынок",
      transcription: "ipa-ბაზარი",
      example: "მაგალითი.",
      exampleTr: "Пример.",
    });
    expect(bot.lastText()).toContain("✅ Добавил 2 новых слова в «Мои слова · KA»");
    expect(bot.lastText()).toContain("<b>ბაზარი</b> — рынок, <b>ხილი</b> — фрукты");
    expect(bot.lastButtons()).toEqual(["x:learn:1", "m"]);
    expect(bot.events.filter((event) => event.name === "word_generated")).toHaveLength(2);
    expect(bot.events.find((event) => event.name === "text_words_added")?.props).toEqual({
      n: 2,
      taken: 0,
    });
  });

  it("drops the words the user already knows and says how many", async () => {
    const bot = textBot({ knownFronts: ["ხილი"] });
    await bot.text(TEXT);
    expect(bot.lastText()).toContain("📝 Нашёл 1 слово");
    expect(bot.lastText()).toContain("Уже знаешь: 1");
    expect(bot.lastText()).not.toContain("ხილი");
  });

  it("names the words it dropped when every one of them is known", async () => {
    const bot = textBot({ knownFronts: ["ბაზარი", "ხილი"] });
    await bot.text(TEXT);
    expect(bot.lastText()).toBe("Все 2 найденных слова ты уже знаешь: <b>ბაზარი</b>, <b>ხილი</b>");
    expect(bot.lastButtons()).toEqual([]);
    // The old «Ничего не добавил. Пропустил N (уже есть).» must never show up
    // for a text: the user has to see what was found.
    expect(bot.lastText()).not.toContain("Ничего не добавил");
  });

  it("marks a word that only waits in a deck the user is subscribed to", async () => {
    const bot = textBot({ library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500 }] });
    await bot.text(TEXT);
    expect(bot.lastText()).toContain("📝 Нашёл 2 слова");
    expect(bot.lastText()).not.toContain("Уже знаешь");
    expect(bot.lastText()).toContain("1. <b>ბაზარი</b> — рынок\n");
    expect(bot.lastText()).toContain(`2. <b>ხილი</b> — фрукты · в деке «${TOP_500}»`);
    expect(bot.user().pendingPayload?.extract?.words[1]?.inDeck).toEqual({
      noteId: 42,
      deckTitle: TOP_500,
    });
    expect(bot.events.find((event) => event.name === "text_extracted")?.props).toMatchObject({
      words: 2,
      dropped: 0,
      inDeck: 1,
    });
  });

  it("takes a word out of its deck instead of generating a second card", async () => {
    const bot = textBot({ library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500 }] });
    await bot.text(TEXT);
    await bot.tap("x:add:1");
    // Only the new word costs a generation and a note.
    expect(bot.generations.map((call) => call.text)).toEqual(["ბაზარი"]);
    expect(bot.notes().map((note) => note.front)).toEqual(["ბაზარი"]);
    // The deck word gets its card, due now, exactly like «Учить сейчас».
    expect(bot.started).toEqual([{ noteId: 42, due: NOW }]);
    expect(bot.lastText()).toContain(
      `✅ Добавил 1 новое слово в «Мои слова · KA» и взял 1 из деки «${TOP_500}» в ближайшую сессию`,
    );
    expect(bot.lastText()).toContain("<b>ბაზარი</b> — рынок");
    expect(bot.events.find((event) => event.name === "text_words_added")?.props).toEqual({
      n: 1,
      taken: 1,
    });
    // Both halves go into «▶️ Учить новые».
    expect(bot.user().pendingPayload?.learn).toEqual([1, 42]);
    expect(bot.lastButtons()).toEqual(["x:learn:1", "m"]);
  });

  it("adds nothing new when every ticked word already lies in a deck", async () => {
    const bot = textBot({
      library: [
        { front: "ბაზარი", noteId: 11, deckTitle: TOP_500 },
        // A card the queue built and the user never answered is not knowledge.
        { front: "ხილი", noteId: 42, deckTitle: TOP_500, reps: 0 },
      ],
    });
    await bot.text(TEXT);
    await bot.tap("x:add:1");
    expect(bot.generations).toHaveLength(0);
    expect(bot.notes()).toHaveLength(0);
    expect(bot.started.map((card) => card.noteId)).toEqual([11, 42]);
    expect(bot.lastText()).toBe(`✅ Взял 2 слова из деки «${TOP_500}» в ближайшую сессию`);
  });

  it("keeps taking deck words when the target deck is changed", async () => {
    const bot = textBot({
      decks: [makeDeck(20, 1, "Мои слова · KA"), makeDeck(21, 1, "Кухня")],
      library: [{ front: "ხილი", noteId: 42, deckTitle: TOP_500 }],
    });
    await bot.text(TEXT);
    await bot.tap("x:deck:1:21");
    expect(bot.lastText()).toContain("→ в деку «Кухня»");
    await bot.tap("x:add:1");
    expect(bot.notes()).toEqual([expect.objectContaining({ front: "ბაზარი", deckId: 21 })]);
    expect(bot.started).toEqual([{ noteId: 42, due: NOW }]);
    expect(bot.lastText()).toContain(`взял 1 из деки «${TOP_500}» в ближайшую сессию`);
  });

  it("says so when there is nothing new in the text", async () => {
    const bot = textBot({ extract: { detectedLang: "ka", words: [] } });
    await bot.text(TEXT);
    expect(bot.lastText()).toBe("Незнакомых слов не нашёл.");
    expect(bot.lastButtons()).toEqual([]);
  });

  it("refuses a text in another language, naming what it saw", async () => {
    const bot = textBot({ extract: { detectedLang: "en", words: [] } });
    await bot.text("The tenant was reluctant to sign the lease agreement.");
    expect(bot.lastText()).toBe(
      "Похоже, это не грузинский, а английский. Нужен текст на языке, который ты учишь: грузинский.",
    );
    expect(bot.notes()).toHaveLength(0);
  });

  it("tells the user their own language is not what it needs", async () => {
    const bot = textBot({ extract: { detectedLang: "ru", words: [] } });
    await bot.text("Сегодня я ходил на рынок и купил фруктов.");
    expect(bot.lastText()).toBe(
      "Это твой родной язык (русский). Нужен текст на языке, который ты учишь: грузинский.",
    );
  });

  it("strips links before sending the text anywhere", async () => {
    const bot = textBot();
    await bot.text(`https://example.com/news/1 ${TEXT} www.test.ge/page`);
    expect(bot.extractions[0]?.text).toBe(TEXT);
    expect(bot.extractions[0]?.text).not.toContain("http");
  });

  it("says nothing was found when a long message is only links", async () => {
    const bot = textBot();
    await bot.text("https://example.com/a/very/long/link/that/is/over/forty/characters");
    expect(bot.extractions).toHaveLength(0);
    expect(bot.lastText()).toBe("Незнакомых слов не нашёл.");
  });

  it("asks for a key instead of crashing when the LLM is off", async () => {
    const bot = createFakeBot({ card: null });
    await bot.text(TEXT);
    expect(bot.lastText()).toBe("Чтобы находить слова в тексте, нужен подключённый ИИ.");
    expect(bot.notes()).toHaveLength(0);
    expect(bot.user().pendingInput).toBeNull();
  });

  it("stops at one text a day on the free plan", async () => {
    const bot = textBot({ proEnabled: true, extractionsUsed: 1 });
    await bot.text(TEXT);
    expect(bot.extractions).toHaveLength(0);
    expect(bot.lastText()).toContain("Разбор текста на сегодня закончился (1 в день)");
  });

  it("skips the words the daily AI budget no longer covers", async () => {
    const bot = textBot({ proEnabled: true, generationsUsed: FREE_LIMITS.generationsPerDay - 1 });
    await bot.text(TEXT);
    await bot.tap("x:add:1");
    expect(bot.generations).toHaveLength(1);
    expect(bot.notes()).toHaveLength(1);
    expect(bot.lastText()).toContain("✅ Добавил 1 новое слово");
    expect(bot.lastText()).toContain("Ещё 1 слово не добавил: на сегодня закончился лимит ИИ.");
  });

  it("asks for a text on /extract and reads the answer", async () => {
    const bot = textBot();
    await bot.text("/extract");
    expect(bot.lastText()).toBe("Пришли текст — найду в нём незнакомые слова.");
    expect(bot.lastButtons()).toEqual(["x:cancel:1"]);
    await bot.text(TEXT);
    expect(bot.lastText()).toContain("📝 Нашёл 2 слова");
    expect(bot.user().pendingInput).toBeNull();
  });

  it("ignores a checklist button once a newer draft exists", async () => {
    const bot = textBot();
    await bot.text(TEXT);
    await bot.text("სახლი");
    await bot.tap("x:add:1");
    expect(bot.notes()).toHaveLength(0);
    expect(bot.toasts()).toContain("Это старое сообщение, отправь слово ещё раз");
  });
});

import type { InlineKeyboardButton } from "grammy/types";
import { describe, expect, it } from "vitest";
import { askScreen, renderGenerated, toPendingCard } from "../src/bot/add.js";
import { callbackByteLength, MAX_CALLBACK_BYTES, parseCallback } from "../src/bot/callbacks.js";
import { renderActions } from "../src/bot/session.js";
import type { PendingCard } from "../src/db/schema.js";
import { createI18n, SUPPORTED_LOCALES, translator } from "../src/i18n/index.js";
import type { GeneratedCard } from "../src/llm/types.js";
import type { SessionView } from "../src/services/sessionService.js";

const i18n = createI18n();
const ru = translator(i18n, "ru");
const en = translator(i18n, "en");
const NOW = new Date("2026-01-10T12:00:00.000Z");

const CARD: GeneratedCard = {
  front: "reluctant",
  back: "неохотный, сопротивляющийся",
  transcription: "rɪˈlʌktənt",
  example: "She was reluctant to go.",
  exampleTr: "Она не хотела идти.",
  pos: "adjective",
  detectedLang: "en",
};

const PENDING: PendingCard = toPendingCard(CARD);

function buttons(keyboard: { inline_keyboard: InlineKeyboardButton[][] } | undefined): string[] {
  return (keyboard?.inline_keyboard ?? []).flat().map((button) => {
    const data = (button as { callback_data?: string }).callback_data ?? "";
    expect(callbackByteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    expect(parseCallback(data)).not.toBeNull();
    return data;
  });
}

describe("generated card preview (SPEC §4.1a)", () => {
  it("shows the word, the IPA, the part of speech, the meaning and the example", () => {
    const screen = renderGenerated(ru, { card: PENDING, deckTitle: "Мои слова · EN", rev: 1 });
    expect(screen.text).toBe(
      [
        "<b>reluctant</b>  <i>/rɪˈlʌktənt/</i> · прил.",
        "неохотный, сопротивляющийся",
        "<i>She was reluctant to go. — Она не хотела идти.</i>",
        "→ в деку «Мои слова · EN»",
      ].join("\n"),
    );
  });

  it("offers add / another deck / own translation / close", () => {
    const screen = renderGenerated(ru, { card: PENDING, deckTitle: "Мои слова · EN", rev: 1 });
    expect(buttons(screen.keyboard)).toEqual(["a:g:1", "a:decks:1", "a:own:1", "a:cancel:1"]);
    expect(screen.keyboard?.inline_keyboard).toHaveLength(2);
  });

  it("renders in English too", () => {
    const screen = renderGenerated(en, { card: PENDING, deckTitle: "My words · EN", rev: 1 });
    expect(screen.text).toContain("adj.");
    expect(screen.text).toContain('→ into "My words · EN"');
  });

  it("localizes the part of speech the prompt returns in English", () => {
    // The model answers `noun` / `verb`; the preview must not.
    const cases: [string, string, string][] = [
      ["noun", "сущ.", "noun"],
      ["verb", "глаг.", "verb"],
      ["adjective", "прил.", "adj."],
      ["adverb", "нареч.", "adv."],
      ["phrase", "фраза", "phrase"],
    ];
    for (const [pos, ru_, en_] of cases) {
      const card = { ...PENDING, pos, transcription: "" };
      expect(renderGenerated(ru, { card, deckTitle: "d", rev: 1 }).text.split("\n")[0]).toBe(
        `<b>reluctant</b>  ${ru_}`,
      );
      expect(renderGenerated(en, { card, deckTitle: "d", rev: 1 }).text.split("\n")[0]).toBe(
        `<b>reluctant</b>  ${en_}`,
      );
    }
  });

  it("drops the part of speech it has no label for", () => {
    const screen = renderGenerated(ru, {
      card: { ...PENDING, pos: "gerundive" },
      deckTitle: "Мои слова · EN",
      rev: 1,
    });
    expect(screen.text.split("\n")[0]).toBe("<b>reluctant</b>  <i>/rɪˈlʌktənt/</i>");
  });

  it("survives a card without a transcription or an example", () => {
    const screen = renderGenerated(ru, {
      card: { ...PENDING, transcription: "", example: "", exampleTr: "" },
      deckTitle: "Мои слова · EN",
      rev: 1,
    });
    expect(screen.text).toBe(
      ["<b>reluctant</b>  прил.", "неохотный, сопротивляющийся", "→ в деку «Мои слова · EN»"].join(
        "\n",
      ),
    );
  });

  it("escapes HTML coming from the model", () => {
    const screen = renderGenerated(ru, {
      card: { ...PENDING, front: "<b>x</b>", example: "", exampleTr: "" },
      deckTitle: "Мои слова · EN",
      rev: 1,
    });
    expect(screen.text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("keeps only the fields a note can hold, plus pos for the preview", () => {
    expect(toPendingCard(CARD)).toEqual({
      front: "reluctant",
      back: "неохотный, сопротивляющийся",
      transcription: "rɪˈlʌktənt",
      example: "She was reluctant to go.",
      exampleTr: "Она не хотела идти.",
      pos: "adjective",
    });
  });
});

describe("manual question", () => {
  it("is the plain SPEC §4.1 screen without a reason", () => {
    const screen = askScreen(ru, { front: "reluctant", deckTitle: "Мои слова · EN", rev: 1 });
    expect(screen.text.split("\n")[0]).toBe("Перевод для «reluctant»?");
    expect(buttons(screen.keyboard)).toEqual(["a:cancel:1", "a:decks:1"]);
  });

  it("explains a failed generation on the first line", () => {
    for (const t of [ru, en]) {
      const screen = askScreen(t, {
        front: "reluctant",
        deckTitle: "Мои слова · EN",
        rev: 1,
        reason: "failed",
      });
      expect(screen.text.split("\n")).toHaveLength(4);
      expect(screen.text).not.toContain("{");
    }
    expect(askScreen(ru, { front: "x", deckTitle: "d", rev: 1, reason: "failed" }).text).toContain(
      "Не удалось подобрать перевод автоматически",
    );
  });

  it("explains a spent daily budget", () => {
    const screen = askScreen(ru, { front: "x", deckTitle: "d", rev: 1, reason: "limit" });
    expect(screen.text.split("\n")[0]).toContain("10");
  });
});

const session = {
  id: 1,
  userId: 1,
  deckId: null,
  chatId: 555,
  messageId: null,
  messageSentAt: null,
  status: "active" as const,
  queue: [{ cardId: 1, isNew: true }],
  position: 0,
  startedAt: NOW,
  finishedAt: null,
  stats: { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, newLearned: 0 },
};

function view(card: Partial<SessionView["card"]> = {}): SessionView {
  return {
    kind: "card",
    session,
    stage: "actions",
    card: {
      cardId: 1,
      noteId: 11,
      deckId: 2,
      deckTitle: "Мои слова · EN",
      deckOwnerId: 1,
      mode: "recognition",
      front: "reluctant",
      back: "неохотный",
      transcription: null,
      example: null,
      exampleTr: null,
      tag: null,
      ...card,
    },
    isNew: true,
    position: 3,
    index: 4,
    total: 25,
    previews: null,
    canUndo: false,
    snowball: false,
    transcriptionMode: "answer",
    choices: null,
    choiceMiss: false,
  };
}

describe("«✨ Дополнить» in the card menu", () => {
  it("appears for an own note that is missing a transcription or an example", () => {
    const screen = renderActions(ru, view(), { canEnrich: true });
    expect(buttons(screen.keyboard)).toContain("c:enr:3");
  });

  it("stays hidden when generation is off", () => {
    expect(buttons(renderActions(ru, view()).keyboard)).not.toContain("c:enr:3");
  });

  it("stays hidden for a complete note and for a builtin one", () => {
    const complete = view({ transcription: "rɪˈlʌktənt", example: "She was reluctant to go." });
    expect(buttons(renderActions(ru, complete, { canEnrich: true }).keyboard)).not.toContain(
      "c:enr:3",
    );
    const builtin = view({ deckOwnerId: null });
    expect(buttons(renderActions(ru, builtin, { canEnrich: true }).keyboard)).not.toContain(
      "c:enr:3",
    );
  });

  it("is labelled in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = translator(i18n, locale);
      const labels = (renderActions(t, view(), { canEnrich: true }).keyboard?.inline_keyboard ?? [])
        .flat()
        .map((button) => button.text);
      expect(labels.some((label) => label.includes("✨"))).toBe(true);
      for (const label of labels) expect(label).not.toContain("{");
    }
  });
});

import type { InlineKeyboardButton } from "grammy/types";
import { describe, expect, it } from "vitest";
import { callbackByteLength, MAX_CALLBACK_BYTES } from "../src/bot/callbacks.js";
import { renderDeckCard } from "../src/bot/decks.js";
import { formatInterval } from "../src/bot/format.js";
import { renderMenu } from "../src/bot/menu.js";
import {
  formatWhen,
  renderActions,
  renderCard,
  renderEmpty,
  renderLeech,
  renderSummary,
} from "../src/bot/session.js";
import type { DeckWithCounts } from "../src/db/repos/decks.js";
import { createI18n, SUPPORTED_LOCALES, translator } from "../src/i18n/index.js";
import type { SessionSummary, SessionView } from "../src/services/sessionService.js";
import { makeUser } from "./helpers/fakeSession.js";

const i18n = createI18n();
const ru = translator(i18n, "ru");
const en = translator(i18n, "en");
const NOW = new Date("2026-01-10T12:00:00.000Z");

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
  stats: { reviewed: 12, again: 3, hard: 5, good: 14, easy: 3, newLearned: 8 },
};

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    kind: "card",
    session,
    stage: "question",
    card: {
      cardId: 1,
      noteId: 11,
      deckId: 2,
      deckTitle: "English Top 1000 · A2",
      deckOwnerId: null,
      mode: "recognition",
      front: "reluctant",
      back: "неохотный, сопротивляющийся",
      transcription: "rɪˈlʌktənt",
      example: "She was reluctant to go.",
      exampleTr: "Она не хотела идти.",
    },
    isNew: true,
    position: 11,
    index: 12,
    total: 25,
    previews: null,
    canUndo: false,
    snowball: false,
    transcriptionMode: "answer",
    ...overrides,
  };
}

function buttons(keyboard: { inline_keyboard: InlineKeyboardButton[][] } | undefined) {
  return (keyboard?.inline_keyboard ?? []).flat();
}

describe("question screen", () => {
  it("shows the deck, the counter and the word", () => {
    const screen = renderCard(ru, view());
    expect(screen.text).toContain("English Top 1000 · A2");
    expect(screen.text).toContain("12 / 25");
    expect(screen.text).toContain("<b>reluctant</b>");
    // Default: the transcription is a hint that belongs to the answer side.
    expect(screen.text).not.toContain("/rɪˈlʌktənt/");
    expect(screen.text).toContain("🆕 новое");
    // The answer must not leak into the question.
    expect(screen.text).not.toContain("неохотный");
  });

  it("shows the transcription in the question only in the 'always' mode", () => {
    expect(renderCard(ru, view({ transcriptionMode: "always" })).text).toContain(
      "<i>/rɪˈlʌktənt/</i>",
    );
    expect(renderCard(ru, view({ transcriptionMode: "never" })).text).not.toContain("rɪˈlʌktənt");
  });

  it("keeps the same structure in English", () => {
    const screen = renderCard(en, view());
    expect(screen.text).toContain("🆕 new");
    expect(buttons(screen.keyboard)[0]?.text).toBe("👁 Show answer");
  });

  it("carries the queue position in every button", () => {
    const screen = renderCard(ru, view());
    const data = buttons(screen.keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).toEqual(["s:show:11", "s:know:11", "c:open:11", "s:skip:11", "s:fin"]);
    for (const item of data)
      expect(callbackByteLength(item)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
  });

  it('offers "Знаю" on new cards only', () => {
    const fresh = renderCard(ru, view());
    expect(buttons(fresh.keyboard).map((b) => b.text)).toContain("✅ Знаю");
    expect(buttons(renderCard(en, view()).keyboard).map((b) => b.text)).toContain("✅ I know it");

    const seen = renderCard(ru, view({ isNew: false }));
    const data = buttons(seen.keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).toEqual(["s:show:11", "c:open:11", "s:skip:11", "s:fin"]);
  });

  it('keeps "Знаю" out of the answer screen', () => {
    const data = buttons(renderCard(ru, view({ stage: "answer" })).keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).not.toContain("s:know:11");
  });

  it("shows the translation for a reverse card", () => {
    const screen = renderCard(ru, view({ card: { ...view().card, mode: "recall" } }));
    expect(screen.text).toContain("неохотный");
    expect(screen.text).not.toContain("<b>reluctant</b>");
  });

  it("mentions the backlog when new cards were held back", () => {
    expect(renderCard(ru, view({ snowball: true })).text).toContain("разгребём");
  });
});

describe("answer screen", () => {
  const answered = view({
    stage: "answer",
    canUndo: true,
    previews: {
      1: { unit: "minute", value: 1 },
      2: { unit: "minute", value: 5 },
      3: { unit: "minute", value: 10 },
      4: { unit: "day", value: 4 },
    },
  });

  it("shows question, answer and example", () => {
    const screen = renderCard(ru, answered);
    expect(screen.text).toContain("<b>reluctant</b>");
    expect(screen.text).toContain("<i>/rɪˈlʌktənt/</i>");
    expect(renderCard(ru, { ...answered, transcriptionMode: "never" }).text).not.toContain(
      "rɪˈlʌktənt",
    );
    expect(screen.text).toContain("неохотный, сопротивляющийся");
    expect(screen.text).toContain("<i>She was reluctant to go.</i>");
    expect(screen.text).toContain("Она не хотела идти.");
  });

  it("keeps rating buttons short and puts the FSRS intervals into the text", () => {
    const screen = renderCard(ru, answered);
    const labels = buttons(screen.keyboard).map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual(["Снова", "Трудно", "Хорошо", "Легко"]);
    expect(screen.text).toContain("Снова &lt;1м · Трудно 5м · Хорошо 10м · Легко 4д");
    const english = renderCard(en, answered);
    expect(
      buttons(english.keyboard)
        .map((b) => b.text)
        .slice(0, 4),
    ).toEqual(["Again", "Hard", "Good", "Easy"]);
    expect(english.text).toContain("Again &lt;1m · Hard 5m · Good 10m · Easy 4d");
  });

  it("encodes position and rating in the callback data", () => {
    const data = buttons(renderCard(ru, answered).keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data.slice(0, 4)).toEqual(["r:11:1", "r:11:2", "r:11:3", "r:11:4"]);
    expect(data).toContain("s:undo");
  });

  it("drops the interval hints when the user turned them off", () => {
    const labels = buttons(renderCard(ru, view({ stage: "answer" })).keyboard).map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual(["Снова", "Трудно", "Хорошо", "Легко"]);
  });

  it("hides undo before the first rating of the session", () => {
    const data = buttons(renderCard(ru, view({ stage: "answer" })).keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).not.toContain("s:undo");
  });
});

describe("interval labels", () => {
  it("renders every unit in both locales", () => {
    expect(formatInterval(ru, { unit: "minute", value: 1 })).toBe("<1м");
    expect(formatInterval(ru, { unit: "minute", value: 5 })).toBe("5м");
    expect(formatInterval(ru, { unit: "hour", value: 1 })).toBe("1ч");
    expect(formatInterval(ru, { unit: "day", value: 3 })).toBe("3д");
    expect(formatInterval(ru, { unit: "month", value: 2 })).toBe("2мес");
    expect(formatInterval(ru, { unit: "year", value: 1 })).toBe("1г");
    expect(formatInterval(en, { unit: "minute", value: 1 })).toBe("<1m");
    expect(formatInterval(en, { unit: "month", value: 2 })).toBe("2mo");
    expect(formatInterval(en, { unit: "year", value: 1.5 })).toBe("1.5y");
  });
});

describe("card actions", () => {
  it('offers "Уже знаю" for every card, new or not', () => {
    for (const isNew of [true, false]) {
      const screen = renderActions(ru, view({ isNew, stage: "actions" }));
      const data = buttons(screen.keyboard).map((button) =>
        "callback_data" in button ? button.callback_data : "",
      );
      expect(data).toContain("c:know:11");
      for (const item of data)
        expect(callbackByteLength(item)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    }
    expect(buttons(renderActions(ru, view()).keyboard).map((b) => b.text)).toContain("✅ Уже знаю");
    expect(buttons(renderActions(en, view()).keyboard).map((b) => b.text)).toContain(
      "✅ Already know it",
    );
  });

  it("offers reporting for builtin decks and deleting for own ones", () => {
    const builtin = buttons(renderActions(ru, view()).keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(builtin).toContain("c:rep:11");
    expect(builtin).not.toContain("c:del:11");

    const own = buttons(
      renderActions(ru, view({ card: { ...view().card, deckOwnerId: 1 } })).keyboard,
    ).map((button) => ("callback_data" in button ? button.callback_data : ""));
    expect(own).toContain("c:del:11");
    expect(own).not.toContain("c:rep:11");
  });
});

describe("summary", () => {
  const summary: SessionSummary = {
    kind: "summary",
    session,
    stats: session.stats,
    minutes: 4,
    accuracy: 88,
    streak: 8,
    remainingDue: 15,
    leech: null,
  };

  it("reports counts, accuracy and the streak", () => {
    const screen = renderSummary(ru, summary);
    expect(screen.text).toContain("12 карточек");
    expect(screen.text).toContain("4 мин");
    expect(screen.text).toContain("Снова 3 · Трудно 5 · Хорошо 14 · Легко 3");
    expect(screen.text).toContain("Точность: 88 %");
    expect(screen.text).toContain("🔥 Стрик: 8 дней");
    expect(screen.text).toContain("Осталось на сегодня: 15 повторений");
  });

  it("offers to continue only while cards remain", () => {
    expect(buttons(renderSummary(ru, summary).keyboard).map((b) => b.text)).toEqual([
      "▶️ Продолжить (15)",
      "Меню",
    ]);
    expect(
      buttons(renderSummary(en, { ...summary, remainingDue: 0 }).keyboard).map((b) => b.text),
    ).toEqual(["Menu"]);
  });
});

describe("empty queue", () => {
  it("names the next due time", () => {
    const at = new Date("2026-01-11T05:00:00.000Z"); // 08:00 MSK the next day
    const screen = renderEmpty(
      ru,
      { kind: "empty", nextAt: at, nextCount: 14, snowball: false },
      { tz: "Europe/Moscow", now: NOW },
    );
    expect(screen.text).toContain("На сегодня всё!");
    expect(screen.text).toContain("завтра в 08:00");
    expect(screen.text).toContain("14 карточек");
    expect(buttons(screen.keyboard).map((b) => b.text)).toEqual(["➕ Ещё 5 новых", "Меню"]);
  });

  it("says so when nothing is scheduled at all", () => {
    const screen = renderEmpty(
      en,
      { kind: "empty", nextAt: null, nextCount: 0, snowball: false },
      { tz: "UTC", now: NOW },
    );
    expect(screen.text).toContain("No new cards either");
  });

  it("formats today, tomorrow and later dates", () => {
    expect(formatWhen(ru, new Date("2026-01-10T16:00:00.000Z"), "Europe/Moscow", NOW)).toBe(
      "сегодня в 19:00",
    );
    expect(formatWhen(ru, new Date("2026-01-11T16:00:00.000Z"), "Europe/Moscow", NOW)).toBe(
      "завтра в 19:00",
    );
    expect(formatWhen(en, new Date("2026-01-20T16:00:00.000Z"), "Europe/Moscow", NOW)).toBe(
      "2026-01-20 at 19:00",
    );
  });
});

describe("leech notice", () => {
  it("names the word and offers to suspend it", () => {
    const screen = renderLeech(ru, { cardId: 42, front: "reluctant" });
    expect(screen.text).toContain("reluctant");
    expect(
      buttons(screen.keyboard).map((button) =>
        "callback_data" in button ? button.callback_data : "",
      ),
    ).toEqual(["lch:susp:42", "lch:keep:42"]);
  });
});

describe("deck card", () => {
  const row: DeckWithCounts = {
    deck: {
      id: 7,
      ownerId: null,
      slug: "en-ru-top-1000-a2",
      title: "English Top 1000 · A2",
      description: "Самые частотные слова уровня A2.",
      langFrom: "en",
      langTo: "ru",
      kind: "builtin",
      level: "A2",
      isPublic: true,
      publicId: null,
      createdAt: NOW,
    },
    newPerDay: 10,
    modes: ["recognition"],
    total: 350,
    due: 12,
    fresh: 148,
    learned: 190,
    disabled: 0,
  };

  it('hides "Отключено" while nothing is switched off', () => {
    const screen = renderDeckCard(ru, row, 1);
    expect(screen.text).not.toContain("Отключено");
    const data = buttons(screen.keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).not.toContain("d:unsusp:7");
  });

  it("counts switched-off cards and offers to bring them back", () => {
    const screen = renderDeckCard(ru, { ...row, disabled: 3 }, 1);
    expect(screen.text).toContain("Отключено: 3");
    const data = buttons(screen.keyboard).map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );
    expect(data).toContain("d:unsusp:7");
    for (const item of data)
      expect(callbackByteLength(item)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    expect(buttons(renderDeckCard(en, { ...row, disabled: 3 }, 1).keyboard).map((b) => b.text)) //
      .toContain("↩️ Bring back");
    expect(renderDeckCard(en, { ...row, disabled: 3 }, 1).text).toContain("Switched off: 3");
  });
});

describe("main menu", () => {
  it("shows counters, the streak and the deck list", () => {
    const screen = renderMenu(ru, {
      due: 12,
      fresh: 10,
      streak: 7,
      deckTitles: ["English Top 1000 · A2", "Мои слова · EN"],
    });
    expect(screen.text).toContain("📚 На сегодня: 12 повторений · 10 новых");
    expect(screen.text).toContain("🔥 7 дней");
    expect(screen.text).toContain("Активные деки: English Top 1000 · A2, Мои слова · EN");
    expect(buttons(screen.keyboard)[0]?.text).toBe("▶️ Учить (22)");
  });

  it("nudges users without decks", () => {
    const screen = renderMenu(en, { due: 0, fresh: 0, streak: 0, deckTitles: [] });
    expect(screen.text).toContain("No decks yet");
    expect(screen.text).not.toContain("🔥");
  });

  it("keeps every menu callback inside the byte budget in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const screen = renderMenu(translator(i18n, locale), {
        due: 1,
        fresh: 1,
        streak: 1,
        deckTitles: [],
      });
      for (const button of buttons(screen.keyboard)) {
        if ("callback_data" in button) {
          expect(callbackByteLength(button.callback_data)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
        }
      }
    }
  });
});

describe("user defaults", () => {
  it("starts with intervals on and 0.9 retention", () => {
    const user = makeUser();
    expect(user.showIntervals).toBe(true);
    expect(user.desiredRetention).toBe(0.9);
  });
});

/**
 * Onboarding and settings around the language pair (SPEC §1, §8). The bug this
 * pins down: `lang_to` used to follow the Telegram interface language, so a
 * Russian speaker with an English Telegram got English translations.
 */

import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS } from "../src/bot/onboarding.js";
import { renderSettings } from "../src/bot/settings.js";
import { createI18n, translator } from "../src/i18n/index.js";
import { createFakeBot } from "./helpers/fakeBot.js";
import { makeUser } from "./helpers/fakeSession.js";

const i18n = createI18n();

function onboarding() {
  return createFakeBot({
    card: null,
    user: { uiLang: "en", langFrom: null, langTo: "en", onboardingStep: "ui_lang" },
  });
}

describe("onboarding asks which language to translate into (SPEC §1)", () => {
  it("has the step between the learning language and the level", () => {
    expect([...ONBOARDING_STEPS]).toEqual([
      "ui_lang",
      "learn_lang",
      "target_lang",
      "level",
      "tz",
      "reminder",
    ]);
  });

  it("does not decide the translation language from the interface language", async () => {
    const bot = onboarding();
    await bot.tap("o:ui:en");
    expect(bot.user().uiLang).toBe("en");
    expect(bot.user().onboardingStep).toBe("learn_lang");
    // Still whatever it was — the question is coming.
    expect(bot.lastText()).toContain("Which language are we learning?");
  });

  it("offers Russian, English, Ukrainian and «Другой…» after the learning language", async () => {
    const bot = onboarding();
    await bot.tap("o:ui:en");
    await bot.tap("o:lang:ka");
    expect(bot.user().langFrom).toBe("ka");
    expect(bot.user().onboardingStep).toBe("target_lang");
    expect(bot.lastText()).toContain("Translate into?");
    // The interface language is a hint in the text, not a preselected button.
    expect(bot.lastText()).toContain("English");
    expect(bot.lastButtons()).toEqual(["o:to:ru", "o:to:en", "o:to:uk", "o:to:other"]);

    await bot.tap("o:to:ru");
    expect(bot.user().langTo).toBe("ru");
    // The level step skips itself when the language has no builtin decks.
    expect(bot.user().onboardingStep).toBe("tz");
  });

  it("takes a typed language name for «Другой…»", async () => {
    const bot = onboarding();
    await bot.tap("o:ui:en");
    await bot.tap("o:lang:ka");
    await bot.tap("o:to:other");
    expect(bot.user().pendingInput).toBe("onb_to");

    await bot.text("не язык вовсе");
    expect(bot.lastText()).toContain("I do not know that language");
    expect(bot.user().langTo).toBe("en");
    expect(bot.user().pendingInput).toBe("onb_to");

    await bot.text("украинский");
    expect(bot.user().langTo).toBe("uk");
    expect(bot.user().pendingInput).toBeNull();
  });

  it("asks the same question when the learning language was typed", async () => {
    const bot = onboarding();
    await bot.tap("o:ui:en");
    await bot.tap("o:lang:other");
    await bot.text("Georgian");
    expect(bot.user().langFrom).toBe("ka");
    expect(bot.user().onboardingStep).toBe("target_lang");
  });
});

describe("the translation language in the settings (SPEC §8)", () => {
  it("shows the learning and the translation language on their own lines", () => {
    const screen = renderSettings(
      translator(i18n, "ru"),
      makeUser({ langFrom: "ka", langTo: "ru", uiLang: "ru" }),
      "15:00",
    );
    expect(screen.text).toContain("Учу: грузинский");
    expect(screen.text).toContain("Переводить на: русский");
    const buttons = (screen.keyboard?.inline_keyboard ?? [])
      .flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    expect(buttons).toContain("set:to");
    expect(buttons).toContain("set:learn");
  });

  it("changes the translation language without touching the interface", async () => {
    const bot = createFakeBot({ card: null, user: { uiLang: "en", langTo: "en", langFrom: "ka" } });
    await bot.tap("set:to");
    expect(bot.lastButtons()).toEqual([
      "set:to:ru",
      "set:to:en",
      "set:to:uk",
      "set:to:other",
      "set",
    ]);
    await bot.tap("set:to:ru");
    expect(bot.user().langTo).toBe("ru");
    expect(bot.user().uiLang).toBe("en");
  });

  it("changes the interface language without touching the translation language", async () => {
    const bot = createFakeBot({ card: null, user: { uiLang: "en", langTo: "ru", langFrom: "ka" } });
    await bot.tap("set:lang:en");
    expect(bot.user().langTo).toBe("ru");
    await bot.tap("set:lang:ru");
    expect(bot.user().uiLang).toBe("ru");
    expect(bot.user().langTo).toBe("ru");
  });

  it("takes a typed language for «Другой…»", async () => {
    const bot = createFakeBot({ card: null, user: { uiLang: "en", langTo: "en", langFrom: "ka" } });
    await bot.tap("set:to:other");
    expect(bot.user().pendingInput).toBe("set_target");
    await bot.text("русский");
    expect(bot.user().langTo).toBe("ru");
    expect(bot.user().pendingInput).toBeNull();
  });
});

describe("the language pair a new personal deck gets", () => {
  it("uses the pair as it is now (SPEC §8)", async () => {
    const bot = createFakeBot({ card: null, user: { langFrom: "ka", langTo: "en" } });
    await bot.tap("set:to:ru");
    await bot.text("ხინკალი - хинкали");
    expect(bot.decks()[0]).toMatchObject({ langFrom: "ka", langTo: "ru" });
    // The deck title stays keyed on the language being learned.
    expect(bot.decks()[0]?.title).toBe("Мои слова · KA");
  });
});

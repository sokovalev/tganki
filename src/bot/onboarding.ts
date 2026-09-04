import { type Bot, InlineKeyboard } from "grammy";
import type { Deck, User } from "../db/schema.js";
import { isSupportedLocale } from "../i18n/index.js";
import {
  FEATURED_LANGUAGES,
  findLanguage,
  languageButton,
  languageName,
  languageTag,
} from "../i18n/languages.js";
import { FIRST_SESSION_SIZE } from "../services/sessionService.js";
import { argStr, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { localTime } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { showMenu } from "./menu.js";
import { openSession } from "./session.js";
import { normalizeReminderTime, offsetFromLocalTime } from "./time.js";
import { answer, type Screen, show } from "./ui.js";

export const ONBOARDING_STEPS = ["ui_lang", "learn_lang", "level", "tz", "reminder"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Reminder presets offered during onboarding and in the settings (SPEC §1, §8). */
export const REMINDER_PRESETS = ["0800", "1300", "2000"] as const;

export function isOnboarding(user: User): boolean {
  return user.onboardingStep !== null;
}

function uiLangScreen(ctx: BotContext): Screen {
  const t = ctx.t.bind(ctx);
  return {
    text: t("onb-hello", { lang: languageName(ctx.user.uiLang, ctx.user.uiLang) }),
    keyboard: new InlineKeyboard()
      .text("Русский", cb(NS.onboarding, "ui", "ru"))
      .text("English", cb(NS.onboarding, "ui", "en")),
  };
}

function learnLangScreen(ctx: BotContext): Screen {
  const t = ctx.t.bind(ctx);
  const keyboard = new InlineKeyboard();
  FEATURED_LANGUAGES.forEach((code, i) => {
    keyboard.text(languageButton(code), cb(NS.onboarding, "lang", code));
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.row().text(t("btn-other-lang"), cb(NS.onboarding, "lang", "other"));
  return { text: t("onb-learn"), keyboard };
}

async function levelScreen(ctx: BotContext, deps: BotDeps): Promise<Screen | null> {
  const t = ctx.t.bind(ctx);
  const langFrom = ctx.user.langFrom ?? "en";
  const catalog = await deps.repos.decks.listCatalog({ userId: ctx.user.id, langFrom });
  const levels = [
    ...new Set(catalog.map((row) => row.deck.level).filter(Boolean)),
  ].sort() as string[];
  if (levels.length === 0) return null;

  const keyboard = new InlineKeyboard();
  const labels: Record<string, string> = {
    // A0 is the Georgian alphabet deck: "не читаю по-грузински" (SPEC §1, step 3).
    A0: t("btn-level-a0"),
    A1: t("btn-level-a1"),
    A2: t("btn-level-a2"),
    B1: t("btn-level-b1"),
  };
  for (const level of levels) {
    keyboard.text(labels[level] ?? level, cb(NS.onboarding, "lvl", level)).row();
  }
  keyboard.text(t("btn-level-unknown"), cb(NS.onboarding, "lvl", "?"));
  return { text: t("onb-level"), keyboard };
}

function tzScreen(ctx: BotContext, deps: BotDeps): Screen {
  const t = ctx.t.bind(ctx);
  return {
    text: t("onb-tz", { time: localTime(deps.now(), ctx.user.tz) }),
    keyboard: new InlineKeyboard()
      .text(t("btn-yes"), cb(NS.onboarding, "tz", "y"))
      .text(t("btn-no"), cb(NS.onboarding, "tz", "n")),
  };
}

function reminderScreen(ctx: BotContext): Screen {
  const t = ctx.t.bind(ctx);
  const keyboard = new InlineKeyboard()
    .text(t("btn-reminder-morning"), cb(NS.onboarding, "rem", "0800"))
    .text(t("btn-reminder-day"), cb(NS.onboarding, "rem", "1300"))
    .row()
    .text(t("btn-reminder-evening"), cb(NS.onboarding, "rem", "2000"))
    .text(t("btn-reminder-off"), cb(NS.onboarding, "rem", "off"));
  return { text: t("onb-reminder"), keyboard };
}

function firstSessionScreen(ctx: BotContext): Screen {
  const t = ctx.t.bind(ctx);
  return {
    text: t("onb-ready", { n: FIRST_SESSION_SIZE }),
    keyboard: new InlineKeyboard()
      .text(t("btn-go"), cb(NS.onboarding, "go"))
      .text(t("btn-later"), cb(NS.onboarding, "later")),
  };
}

/** Renders whichever onboarding step the user is on. */
export async function showStep(ctx: BotContext, deps: BotDeps, step: string): Promise<void> {
  switch (step) {
    case "ui_lang":
      await show(ctx, uiLangScreen(ctx));
      return;
    case "learn_lang":
      await show(ctx, learnLangScreen(ctx));
      return;
    case "level": {
      const screen = await levelScreen(ctx, deps);
      if (screen) {
        await show(ctx, screen);
        return;
      }
      await advance(ctx, deps, "tz");
      return;
    }
    case "tz":
      await show(ctx, tzScreen(ctx, deps));
      return;
    case "reminder":
      await show(ctx, reminderScreen(ctx));
      return;
    default:
      await show(ctx, firstSessionScreen(ctx));
  }
}

async function advance(ctx: BotContext, deps: BotDeps, step: OnboardingStep): Promise<void> {
  ctx.setUser(await deps.repos.users.update(ctx.user.id, { onboardingStep: step }));
  await showStep(ctx, deps, step);
}

/** The user's own deck for the language they are learning («Мои слова · EN»). */
export async function ensurePersonalDeck(ctx: BotContext, deps: BotDeps): Promise<Deck> {
  const title = ctx.t("deck-personal", { lang: languageTag(ctx.user.langFrom ?? "en") });
  return deps.add.personalDeck(ctx.user, title);
}

/** Closes onboarding: personal deck, pending deep link, analytics. */
async function completeOnboarding(ctx: BotContext, deps: BotDeps): Promise<void> {
  const payload = ctx.user.pendingPayload;
  ctx.setUser(
    await deps.repos.users.update(ctx.user.id, {
      onboardingStep: null,
      pendingInput: null,
      pendingInputExpiresAt: null,
      pendingPayload: null,
    }),
  );
  await ensurePersonalDeck(ctx, deps);
  if (payload?.deckRef) {
    const deck = await deps.repos.decks.findByRef(payload.deckRef);
    if (deck) {
      await deps.repos.decks.subscribe(ctx.user.id, deck.id);
      deps.events.record(ctx.user.id, "deck_subscribed", { deckId: deck.id, via: "deeplink" });
    }
  }
  deps.events.record(ctx.user.id, "onboarding_done", {});
}

/** Handles the free-text answers onboarding asks for. Returns true when consumed. */
export async function handleOnboardingInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending === "onb_lang") {
    const language = findLanguage(text);
    if (!language) {
      await ctx.reply(ctx.t("onb-lang-unknown"));
      return true;
    }
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        langFrom: language.code,
        pendingInput: null,
        pendingInputExpiresAt: null,
      }),
    );
    await advance(ctx, deps, "level");
    return true;
  }

  if (pending === "onb_tz") {
    const offset = offsetFromLocalTime(deps.now(), text);
    if (!offset) {
      await ctx.reply(ctx.t("onb-tz-bad"));
      return true;
    }
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        tz: offset,
        pendingInput: null,
        pendingInputExpiresAt: null,
      }),
    );
    await ctx.reply(ctx.t("onb-tz-saved", { offset }));
    await advance(ctx, deps, "reminder");
    return true;
  }

  return false;
}

export function installOnboarding(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const payload = (ctx.match ?? "").trim();
    const deckRef = payload.startsWith("deck_") ? payload.slice("deck_".length) : null;
    deps.events.record(ctx.user.id, "start", payload ? { payload } : {});

    if (!isOnboarding(ctx.user)) {
      if (deckRef) {
        const deck = await deps.repos.decks.findByRef(deckRef);
        if (deck) {
          await deps.repos.decks.subscribe(ctx.user.id, deck.id);
          deps.events.record(ctx.user.id, "deck_subscribed", { deckId: deck.id, via: "deeplink" });
          await ctx.reply(ctx.t("deck-subscribed", { title: deck.title }), {
            reply_markup: new InlineKeyboard()
              .text(ctx.t("btn-learn-deck"), cb(NS.learn, "d", deck.id))
              .text(ctx.t("btn-menu"), cb(NS.menu)),
          });
          return;
        }
      }
      await showMenu(ctx, deps);
      return;
    }

    if (deckRef) {
      ctx.setUser(await deps.repos.users.update(ctx.user.id, { pendingPayload: { deckRef } }));
    }
    await showStep(ctx, deps, ctx.user.onboardingStep ?? "ui_lang");
  });

  bot.callbackQuery(/^o:ui:/u, async (ctx) => {
    await answer(ctx);
    const code = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "ru";
    const locale = isSupportedLocale(code) ? code : "ru";
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { uiLang: locale, langTo: locale }));
    ctx.i18n.useLocale(locale);
    await advance(ctx, deps, "learn_lang");
  });

  bot.callbackQuery(/^o:lang:/u, async (ctx) => {
    await answer(ctx);
    const code = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "en";
    if (code === "other") {
      ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, "onb_lang"));
      await show(ctx, { text: ctx.t("onb-lang-ask") });
      return;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { langFrom: code }));
    await advance(ctx, deps, "level");
  });

  bot.callbackQuery(/^o:lvl:/u, async (ctx) => {
    await answer(ctx);
    const level = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "?";
    const langFrom = ctx.user.langFrom ?? "en";
    const catalog = await deps.repos.decks.listCatalog({ userId: ctx.user.id, langFrom });
    const chosen =
      catalog.find((row) => row.deck.level === level) ??
      catalog.find((row) => row.deck.level === "A2") ??
      catalog[0];
    if (chosen) {
      await deps.repos.decks.subscribe(ctx.user.id, chosen.deck.id);
      deps.events.record(ctx.user.id, "deck_subscribed", {
        deckId: chosen.deck.id,
        via: "onboarding",
      });
    }
    await advance(ctx, deps, "tz");
  });

  bot.callbackQuery(/^o:tz:/u, async (ctx) => {
    await answer(ctx);
    const choice = argStr(parseCallback(ctx.callbackQuery.data)!, 0);
    if (choice === "n") {
      ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, "onb_tz"));
      await show(ctx, { text: ctx.t("onb-tz-ask") });
      return;
    }
    await advance(ctx, deps, "reminder");
  });

  bot.callbackQuery(/^o:rem:/u, async (ctx) => {
    await answer(ctx);
    const choice = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "off";
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        reminderTime: choice === "off" ? null : normalizeReminderTime(choice),
      }),
    );
    await completeOnboarding(ctx, deps);
    await show(ctx, firstSessionScreen(ctx));
  });

  bot.callbackQuery("o:go", async (ctx) => {
    await answer(ctx);
    await openSession(ctx, deps, { newLimit: FIRST_SESSION_SIZE });
  });

  bot.callbackQuery("o:later", async (ctx) => {
    await answer(ctx);
    await showMenu(ctx, deps);
  });
}

import { type Bot, InlineKeyboard } from "grammy";
import type { NewCardStyle, TranscriptionMode, User } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import { isSupportedLocale } from "../i18n/index.js";
import {
  FEATURED_LANGUAGES,
  findLanguage,
  languageButton,
  languageName,
  TARGET_LANGUAGES,
} from "../i18n/languages.js";
import { isPro } from "../services/limits.js";
import { argStr, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { localTime } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { showMenu } from "./menu.js";
import { normalizeReminderTime, offsetFromLocalTime } from "./time.js";
import { answer, type Screen, show } from "./ui.js";

export const NEW_PER_DAY_OPTIONS = [5, 10, 20, 30] as const;
export const RETENTION_OPTIONS = [0.8, 0.85, 0.9, 0.95] as const;
export const TZ_INPUT = "tz_time";
export const LANG_INPUT = "set_lang";
/** «🌐 Язык перевода» → «Другой…». */
export const TARGET_INPUT = "set_target";
export const NEW_LIMIT_INPUT = "set_new_limit";
export const DELETE_INPUT = "delete_account";
/** Typed confirmation for account deletion (SPEC §8). */
export const DELETE_WORDS = ["УДАЛИТЬ", "DELETE"];

/** Cycles «выбор из четырёх» ⇄ «показать ответ» (SPEC §3.2, §8). */
export function nextNewCardStyle(style: NewCardStyle): NewCardStyle {
  return style === "choice" ? "reveal" : "choice";
}

export function renderSettings(
  t: Translate,
  user: User,
  localNow: string,
  options: { proLocked?: boolean } = {},
): Screen {
  const lines = [
    t("settings-title"),
    "",
    t("settings-ui-lang", { value: languageName(user.uiLang, user.uiLang) }),
    t("settings-learn", { value: languageName(user.langFrom ?? "en", user.uiLang) }),
    // Independent of the interface language: a Russian speaker on an English
    // Telegram still wants Russian translations (SPEC §1 step 3, §8).
    t("settings-target", { value: languageName(user.langTo ?? user.uiLang, user.uiLang) }),
    t("settings-new-limit", { value: user.dailyNewLimit }),
    t("settings-reminder", { value: user.reminderTime ?? t("settings-off") }),
    // Rides on the reminder switch: with reminders off there is nothing to
    // toggle, and the weekly report follows the same switch (SPEC §6.2, §6.3).
    t("settings-streak-nudge", {
      value: user.reminderTime && user.streakNudge ? t("btn-on") : t("btn-off"),
    }),
    t("settings-tz", { value: user.tz, time: localNow }),
    t("settings-intervals", { value: user.showIntervals ? t("btn-on") : t("btn-off") }),
    t("settings-transcription", { value: t(`tr-mode-${user.transcriptionMode}`) }),
    // Choice is a Pro presentation (SPEC §9.1); with the gate on, a free user
    // sees the row locked instead of it quietly doing nothing.
    t("settings-new-style", { value: t(`new-style-${user.newCardStyle}`) }) +
      (options.proLocked ? " 🔒" : ""),
    t("settings-retention", { value: user.desiredRetention.toFixed(2) }),
  ];
  const keyboard = new InlineKeyboard()
    .text(t("btn-set-ui-lang"), cb(NS.settings, "lang"))
    .text(t("btn-set-learn-lang"), cb(NS.settings, "learn"))
    .row()
    .text(t("btn-set-target-lang"), cb(NS.settings, "to"))
    .row()
    .text(t("btn-set-new-limit"), cb(NS.settings, "new"))
    .text(t("btn-set-reminder"), cb(NS.settings, "rem"))
    .row()
    .text(t("btn-set-streak-nudge"), cb(NS.settings, "sn"))
    .row()
    .text(t("btn-set-tz"), cb(NS.settings, "tz"))
    .text(t("btn-set-intervals"), cb(NS.settings, "iv"))
    .row()
    .text(t("btn-set-transcription"), cb(NS.settings, "tr"))
    .text(t("btn-set-retention"), cb(NS.settings, "ret"))
    .row()
    .text(t("btn-set-new-style"), cb(NS.settings, "style"))
    .row()
    .text(t("btn-delete-account"), cb(NS.settings, "del"))
    .row()
    .text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

const TRANSCRIPTION_MODES: readonly TranscriptionMode[] = ["answer", "always", "never"];

/** Cycles answer → always → never → answer. */
export function nextTranscriptionMode(mode: TranscriptionMode): TranscriptionMode {
  const i = TRANSCRIPTION_MODES.indexOf(mode);
  return TRANSCRIPTION_MODES[(i + 1) % TRANSCRIPTION_MODES.length] as TranscriptionMode;
}

/** True when the Free-plan gate is on and this user is not paying (SPEC §9.1). */
function proLocked(ctx: BotContext, deps: BotDeps): boolean {
  return deps.config.PRO_ENABLED && !isPro(ctx.user, deps.now());
}

async function showSettings(ctx: BotContext, deps: BotDeps): Promise<void> {
  await show(
    ctx,
    renderSettings(ctx.t.bind(ctx), ctx.user, localTime(deps.now(), ctx.user.tz), {
      proLocked: proLocked(ctx, deps),
    }),
  );
}

/** Free-text answers the settings screens ask for. */
export async function handleSettingsInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending === TZ_INPUT) {
    const offset = offsetFromLocalTime(deps.now(), text);
    if (!offset) {
      await ctx.reply(ctx.t("onb-tz-bad"));
      return true;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { tz: offset }));
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    await showSettings(ctx, deps);
    return true;
  }

  if (pending === LANG_INPUT) {
    const language = findLanguage(text);
    if (!language) {
      await ctx.reply(ctx.t("onb-lang-unknown"));
      return true;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { langFrom: language.code }));
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    await showSettings(ctx, deps);
    return true;
  }

  if (pending === TARGET_INPUT) {
    const language = findLanguage(text);
    if (!language) {
      await ctx.reply(ctx.t("onb-lang-unknown"));
      return true;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { langTo: language.code }));
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    await showSettings(ctx, deps);
    return true;
  }

  if (pending === NEW_LIMIT_INPUT) {
    const value = Number(text.trim());
    if (!Number.isSafeInteger(value) || value < 0 || value > 999) {
      await ctx.reply(ctx.t("settings-new-limit-bad"));
      return true;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { dailyNewLimit: value }));
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    await showSettings(ctx, deps);
    return true;
  }

  if (pending === DELETE_INPUT) {
    if (!DELETE_WORDS.includes(text.trim().toUpperCase())) {
      ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
      await ctx.reply(ctx.t("settings-delete-cancelled"));
      return true;
    }
    await deps.events.recordAsync(ctx.user.id, "account_deleted", {});
    await deps.repos.users.deleteById(ctx.user.id);
    await ctx.reply(ctx.t("settings-deleted"));
    return true;
  }

  return false;
}

export function installSettings(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("settings", async (ctx) => {
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set", async (ctx) => {
    await answer(ctx);
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:lang", async (ctx) => {
    await answer(ctx);
    await show(ctx, {
      text: ctx.t("settings-ask-ui-lang"),
      keyboard: new InlineKeyboard()
        .text("Русский", cb(NS.settings, "lang", "ru"))
        .text("English", cb(NS.settings, "lang", "en"))
        .row()
        .text(ctx.t("btn-back"), cb(NS.settings)),
    });
  });

  bot.callbackQuery(/^set:lang:/u, async (ctx) => {
    await answer(ctx);
    const code = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "ru";
    const locale = isSupportedLocale(code) ? code : "ru";
    ctx.i18n.useLocale(locale);
    // The translation language has its own button; changing the interface
    // must not silently re-translate everything the user adds next.
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { uiLang: locale }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:learn", async (ctx) => {
    await answer(ctx);
    const keyboard = new InlineKeyboard();
    FEATURED_LANGUAGES.forEach((code, i) => {
      keyboard.text(languageButton(code), cb(NS.settings, "learn", code));
      if (i % 2 === 1) keyboard.row();
    });
    keyboard
      .row()
      .text(ctx.t("btn-other-lang"), cb(NS.settings, "learn", "other"))
      .row()
      .text(ctx.t("btn-back"), cb(NS.settings));
    await show(ctx, { text: ctx.t("settings-ask-learn-lang"), keyboard });
  });

  bot.callbackQuery(/^set:learn:/u, async (ctx) => {
    await answer(ctx);
    const code = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "en";
    if (code === "other") {
      ctx.setUser(
        await deps.repos.users.setPendingInput(ctx.user.id, LANG_INPUT, { now: deps.now() }),
      );
      await show(ctx, { text: ctx.t("onb-lang-ask") });
      return;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { langFrom: code }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:to", async (ctx) => {
    await answer(ctx);
    const keyboard = new InlineKeyboard();
    TARGET_LANGUAGES.forEach((code, i) => {
      keyboard.text(languageButton(code), cb(NS.settings, "to", code));
      if (i % 2 === 1) keyboard.row();
    });
    keyboard
      .row()
      .text(ctx.t("btn-other-lang"), cb(NS.settings, "to", "other"))
      .row()
      .text(ctx.t("btn-back"), cb(NS.settings));
    await show(ctx, { text: ctx.t("settings-ask-target-lang"), keyboard });
  });

  bot.callbackQuery(/^set:to:/u, async (ctx) => {
    await answer(ctx);
    const code = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? ctx.user.uiLang;
    if (code === "other") {
      ctx.setUser(
        await deps.repos.users.setPendingInput(ctx.user.id, TARGET_INPUT, { now: deps.now() }),
      );
      await show(ctx, { text: ctx.t("onb-lang-ask") });
      return;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { langTo: code }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:new", async (ctx) => {
    await answer(ctx);
    const keyboard = new InlineKeyboard();
    for (const option of NEW_PER_DAY_OPTIONS) {
      keyboard.text(String(option), cb(NS.settings, "new", option));
    }
    keyboard
      .row()
      .text(ctx.t("btn-custom-number"), cb(NS.settings, "new", "c"))
      .row()
      .text(ctx.t("btn-back"), cb(NS.settings));
    await show(ctx, { text: ctx.t("settings-ask-new-limit"), keyboard });
  });

  bot.callbackQuery(/^set:new:/u, async (ctx) => {
    await answer(ctx);
    const value = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "10";
    if (value === "c") {
      ctx.setUser(
        await deps.repos.users.setPendingInput(ctx.user.id, NEW_LIMIT_INPUT, { now: deps.now() }),
      );
      await show(ctx, { text: ctx.t("settings-ask-new-limit-custom") });
      return;
    }
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { dailyNewLimit: Number(value) }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:rem", async (ctx) => {
    await answer(ctx);
    await show(ctx, {
      text: ctx.t("settings-ask-reminder"),
      keyboard: new InlineKeyboard()
        .text(ctx.t("btn-reminder-morning"), cb(NS.settings, "rem", "0800"))
        .text(ctx.t("btn-reminder-day"), cb(NS.settings, "rem", "1300"))
        .row()
        .text(ctx.t("btn-reminder-evening"), cb(NS.settings, "rem", "2000"))
        .text(ctx.t("btn-reminder-off"), cb(NS.settings, "rem", "off"))
        .row()
        .text(ctx.t("btn-back"), cb(NS.settings)),
    });
  });

  bot.callbackQuery(/^set:rem:/u, async (ctx) => {
    await answer(ctx);
    const value = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "off";
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        reminderTime: value === "off" ? null : normalizeReminderTime(value),
      }),
    );
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:sn", async (ctx) => {
    await answer(ctx);
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { streakNudge: !ctx.user.streakNudge }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:tz", async (ctx) => {
    await answer(ctx);
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, TZ_INPUT, { now: deps.now() }));
    await show(ctx, { text: ctx.t("onb-tz-ask") });
  });

  bot.callbackQuery("set:iv", async (ctx) => {
    await answer(ctx);
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, { showIntervals: !ctx.user.showIntervals }),
    );
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:tr", async (ctx) => {
    await answer(ctx);
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        transcriptionMode: nextTranscriptionMode(ctx.user.transcriptionMode),
      }),
    );
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:style", async (ctx) => {
    await answer(ctx);
    if (proLocked(ctx, deps)) {
      await show(ctx, {
        text: ctx.t("settings-new-style-pro"),
        keyboard: new InlineKeyboard()
          .text(ctx.t("btn-pro"), cb(NS.pro))
          .text(ctx.t("btn-back"), cb(NS.settings)),
      });
      return;
    }
    ctx.setUser(
      await deps.repos.users.update(ctx.user.id, {
        newCardStyle: nextNewCardStyle(ctx.user.newCardStyle),
      }),
    );
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:ret", async (ctx) => {
    await answer(ctx);
    if (proLocked(ctx, deps)) {
      await show(ctx, {
        text: ctx.t("settings-retention-pro"),
        keyboard: new InlineKeyboard()
          .text(ctx.t("btn-pro"), cb(NS.pro))
          .text(ctx.t("btn-back"), cb(NS.settings)),
      });
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const option of RETENTION_OPTIONS) {
      keyboard.text(option.toFixed(2), cb(NS.settings, "ret", String(Math.round(option * 100))));
    }
    keyboard.row().text(ctx.t("btn-back"), cb(NS.settings));
    await show(ctx, { text: ctx.t("settings-ask-retention"), keyboard });
  });

  bot.callbackQuery(/^set:ret:/u, async (ctx) => {
    await answer(ctx);
    const value = Number(argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "90") / 100;
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { desiredRetention: value }));
    await showSettings(ctx, deps);
  });

  bot.callbackQuery("set:del", async (ctx) => {
    await answer(ctx);
    ctx.setUser(
      await deps.repos.users.setPendingInput(ctx.user.id, DELETE_INPUT, { now: deps.now() }),
    );
    await show(ctx, {
      text: ctx.t("settings-ask-delete", { word: DELETE_WORDS[0]! }),
      keyboard: new InlineKeyboard().text(ctx.t("btn-cancel"), cb(NS.settings)),
    });
  });

  bot.callbackQuery("set:menu", async (ctx) => {
    await answer(ctx);
    await showMenu(ctx, deps);
  });
}

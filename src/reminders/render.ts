import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import { esc, percent } from "../bot/format.js";
import { cb, NS } from "../bot/keyboards.js";
import type { Screen } from "../bot/ui.js";
import { MATURE_STABILITY_DAYS } from "../db/repos/decks.js";
import type { Translate } from "../i18n/index.js";
import type {
  ReminderMessage,
  ReminderPayload,
  StreakNudgePayload,
  WeeklyReportPayload,
} from "../services/reminderService.js";
import { WEEK_DAYS } from "../services/reminderService.js";

/** «31 авг» / «6 Sep». Intl abbreviates with a trailing dot in Russian; drop it. */
export function formatDay(day: string, locale: string): string {
  const dt = DateTime.fromISO(day, { zone: "UTC" }).setLocale(locale);
  return (dt.isValid ? dt.toFormat("d MMM") : day).replace(/\.$/u, "");
}

/** The daily nudge (SPEC §6.2). */
export function renderReminder(t: Translate, payload: ReminderPayload): Screen {
  const lines = [
    t("reminder-text", {
      due: payload.due,
      new: payload.fresh,
      minutes: payload.minutes,
    }),
  ];
  if (payload.streak > 0) lines.push(t("reminder-streak", { n: payload.streak }));
  return {
    text: lines.join(" "),
    keyboard: new InlineKeyboard().text(t("btn-start-learning"), cb(NS.session, "rmd")),
  };
}

/** «Стрик в опасности» (SPEC §6.2). */
export function renderStreakNudge(t: Translate, payload: StreakNudgePayload): Screen {
  const lines = [t("streak-nudge-text", { n: payload.streak, hours: payload.hours })];
  if (payload.freeze) lines.push(t("streak-nudge-freeze"));
  return {
    text: lines.join(" "),
    keyboard: new InlineKeyboard().text(t("btn-start-learning"), cb(NS.session, "rmd")),
  };
}

/** The Monday report (SPEC §6.3). */
export function renderWeeklyReport(
  t: Translate,
  locale: string,
  payload: WeeklyReportPayload,
): Screen {
  const lines = [
    t("weekly-title", {
      from: formatDay(payload.from, locale),
      to: formatDay(payload.to, locale),
    }),
  ];
  if (payload.idle) {
    lines.push(t("weekly-idle", { n: payload.streak }));
  } else {
    lines.push(
      t("weekly-reviews", {
        reviews: payload.reviews,
        accuracy: percent(payload.correct, payload.reviews),
      }),
      t("weekly-new", {
        new: payload.newCards,
        mature: MATURE_STABILITY_DAYS,
        learned: payload.learned,
      }),
      t("weekly-days", {
        days: payload.daysStudied,
        total: WEEK_DAYS,
        streak: payload.streak,
      }),
    );
    if (payload.hardest.length > 0) {
      lines.push(t("weekly-hardest", { words: payload.hardest.map(esc).join(", ") }));
    }
    lines.push(t("weekly-forecast", { reviews: payload.forecast }));
  }
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard()
      .text(t("btn-learn-now"), cb(NS.learn))
      .text(t("btn-stats"), cb(NS.stats)),
  };
}

/** One entry point for the sender: message in, screen out. */
export function renderMessage(t: Translate, locale: string, message: ReminderMessage): Screen {
  switch (message.kind) {
    case "reminder":
      return renderReminder(t, message);
    case "streak_nudge":
      return renderStreakNudge(t, message);
    case "weekly_report":
      return renderWeeklyReport(t, locale, message);
  }
}

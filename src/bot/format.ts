import { DateTime } from "luxon";
import type { Interval, ReviewRating } from "../core/scheduler.js";
import type { Translate } from "../i18n/index.js";

export const SEPARATOR = "━━━━━━━━━━━━━━━";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escapes user-provided text for `parse_mode: "HTML"`. */
export function esc(text: string): string {
  return text.replace(/[&<>]/gu, (char) => HTML_ESCAPES[char] ?? char);
}

export function bold(text: string): string {
  return `<b>${text}</b>`;
}

export function italic(text: string): string {
  return `<i>${text}</i>`;
}

/**
 * Shortens a button label to `max` characters. Telegram cuts long labels
 * itself, wherever it likes; an explicit ellipsis at least stays readable.
 */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** Drops a trailing ".0" so 1.5 months stays "1.5" but 2.0 becomes "2". */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/**
 * "<1м" / "5м" / "1ч" / "3д" / "2мес" / "1г" — the hint under a rating button.
 * Anything below a minute is reported as "<1м" (FSRS never schedules 0).
 */
export function formatInterval(t: Translate, interval: Interval): string {
  switch (interval.unit) {
    case "minute":
      return interval.value <= 1 ? t("iv-lt-min") : t("iv-min", { n: num(interval.value) });
    case "hour":
      return t("iv-hour", { n: num(interval.value) });
    case "day":
      return t("iv-day", { n: num(interval.value) });
    case "month":
      return t("iv-month", { n: num(interval.value) });
    case "year":
      return t("iv-year", { n: num(interval.value) });
  }
}

export const RATING_KEYS: Record<ReviewRating, string> = {
  1: "rating-again",
  2: "rating-hard",
  3: "rating-good",
  4: "rating-easy",
};

export function ratingLabel(t: Translate, rating: ReviewRating): string {
  return t(RATING_KEYS[rating]);
}

/** Local "HH:MM" in the user's timezone (fixed offset like "+03:00" or an IANA zone). */
export function localTime(now: Date, tz: string): string {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return (dt.isValid ? dt : DateTime.fromJSDate(now, { zone: "UTC" })).toFormat("HH:mm");
}

/** Local "YYYY-MM-DD HH:MM" is never shown; this is the short "завтра в 08:00" part. */
export function localTimeOf(date: Date, tz: string): string {
  return localTime(date, tz);
}

/** Percentage rounded to a whole number; 0 reviews reads as 0. */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Whole minutes, at least 1, for "· 4 мин" in the session summary. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/** Estimated session length: 12 seconds per card (SPEC §6.2). */
export function estimateMinutes(cards: number): number {
  return Math.max(1, Math.round((cards * 12) / 60));
}

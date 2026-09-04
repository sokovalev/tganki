import { DateTime } from "luxon";

/** Timezone offsets are rounded to half-hours (SPEC decision 6). */
export const OFFSET_STEP_MINUTES = 30;

export interface HourMinute {
  hours: number;
  minutes: number;
}

/** Accepts "21:15", "21.15", "21 15", "9:05", "21" and "2115". */
export function parseHhMm(text: string): HourMinute | null {
  const trimmed = text.trim();
  const separated = /^(\d{1,2})\s*[:.\s-]\s*(\d{2})$/u.exec(trimmed);
  const compact = /^(\d{3,4})$/u.exec(trimmed);
  const hourOnly = /^(\d{1,2})$/u.exec(trimmed);

  let hours: number;
  let minutes: number;
  if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (compact) {
    const digits = compact[1]!.padStart(4, "0");
    hours = Number(digits.slice(0, 2));
    minutes = Number(digits.slice(2));
  } else if (hourOnly) {
    hours = Number(hourOnly[1]);
    minutes = 0;
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** "+03:00" / "-05:30" / "+00:00". */
export function formatOffset(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * Turns "сейчас у меня 21:15" into a fixed UTC offset, rounded to 30 minutes
 * and normalized into the real-world range (-12:00 … +14:00).
 */
export function offsetFromLocalTime(now: Date, text: string): string | null {
  const parsed = parseHhMm(text);
  if (!parsed) return null;
  const utc = DateTime.fromJSDate(now, { zone: "UTC" });
  const utcMinutes = utc.hour * 60 + utc.minute;
  const localMinutes = parsed.hours * 60 + parsed.minutes;
  let diff = localMinutes - utcMinutes;
  // Wrap into (-720, 720]: the user cannot be more than half a day away.
  diff = ((((diff + 720) % 1440) + 1440) % 1440) - 720;
  let rounded = Math.round(diff / OFFSET_STEP_MINUTES) * OFFSET_STEP_MINUTES;
  if (rounded <= -720) rounded += 1440;
  if (rounded > 840) rounded -= 1440;
  return formatOffset(rounded);
}

/** Validates a "HH:MM" reminder time coming from a button or free text. */
export function normalizeReminderTime(text: string): string | null {
  const parsed = parseHhMm(text);
  if (!parsed) return null;
  return `${String(parsed.hours).padStart(2, "0")}:${String(parsed.minutes).padStart(2, "0")}`;
}

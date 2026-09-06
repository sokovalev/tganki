import { DateTime } from "luxon";

/** A user's day starts at 04:00 local time, like Anki — night sessions count for the previous day. */
export const DAY_START_HOUR = 4;
/** One missed day per week does not reset the streak (CONCEPT §2.5). */
export const FREEZE_WINDOW_DAYS = 7;

/** "YYYY-MM-DD" of a learning day. */
export type DayKey = string;

function zoned(now: Date, tz: string): DateTime {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return dt.isValid ? dt : DateTime.fromJSDate(now, { zone: "UTC" });
}

/** Instant at which the learning day containing `now` started. */
export function startOfLearningDay(now: Date, tz: string, hour = DAY_START_HOUR): Date {
  const local = zoned(now, tz);
  const boundary = local.startOf("day").plus({ hours: hour });
  return (local < boundary ? boundary.minus({ days: 1 }) : boundary).toJSDate();
}

/** Instant at which the current learning day ends (= start of the next one). */
export function endOfLearningDay(now: Date, tz: string, hour = DAY_START_HOUR): Date {
  return DateTime.fromJSDate(startOfLearningDay(now, tz, hour), { zone: "UTC" })
    .plus({ days: 1 })
    .toJSDate();
}

/** Calendar label of the learning day containing `now`. */
export function learningDayKey(now: Date, tz: string, hour = DAY_START_HOUR): DayKey {
  const start = startOfLearningDay(now, tz, hour);
  return zoned(start, tz).toISODate() ?? zoned(start, "UTC").toISODate() ?? "1970-01-01";
}

/** Whole days between two "YYYY-MM-DD" keys (`b - a`). */
export function daysBetween(a: DayKey, b: DayKey): number {
  const from = DateTime.fromISO(a, { zone: "UTC" });
  const to = DateTime.fromISO(b, { zone: "UTC" });
  return Math.round(to.diff(from, "days").days);
}

export interface StreakState {
  streak: number;
  lastDay: DayKey | null;
  /** Day on which the weekly freeze was last spent. */
  freezeDay: DayKey | null;
}

export interface StreakUpdate extends StreakState {
  /** True when this activity extended the streak (for "🔥 N days" messages). */
  extended: boolean;
  /** True when a missed day was covered by the weekly freeze. */
  freezeUsed: boolean;
  /** True when the streak was broken and restarted at 1. */
  reset: boolean;
}

/** Is the weekly freeze still unspent on `today`? (Shown in the streak nudge, §6.2.) */
export function freezeAvailable(state: StreakState, today: DayKey): boolean {
  return state.freezeDay === null || daysBetween(state.freezeDay, today) >= FREEZE_WINDOW_DAYS;
}

/**
 * Streak transition for activity on `today`:
 * same day → no change, next day → +1, exactly one missed day → +1 if the
 * weekly freeze is available, anything longer → restart at 1.
 */
export function updateStreak(state: StreakState, today: DayKey): StreakUpdate {
  const base = { ...state, extended: false, freezeUsed: false, reset: false };

  if (state.lastDay === null) {
    return { ...base, streak: 1, lastDay: today, extended: true };
  }

  const gap = daysBetween(state.lastDay, today);
  if (gap <= 0) return base;
  if (gap === 1) {
    return { ...base, streak: state.streak + 1, lastDay: today, extended: true };
  }
  if (gap === 2 && freezeAvailable(state, today)) {
    return {
      ...base,
      streak: state.streak + 1,
      lastDay: today,
      freezeDay: today,
      extended: true,
      freezeUsed: true,
    };
  }
  return { ...base, streak: 1, lastDay: today, reset: true };
}

/** Convenience wrapper: streak transition for a session happening at `now`. */
export function recordActivity(state: StreakState, now: Date, tz: string): StreakUpdate {
  return updateStreak(state, learningDayKey(now, tz));
}

import { DateTime } from "luxon";
import { estimateMinutes } from "../bot/format.js";
import {
  type DayKey,
  daysBetween,
  endOfLearningDay,
  freezeAvailable,
  learningDayKey,
  startOfLearningDay,
} from "../core/streak.js";
import type { EventName } from "../db/repos/events.js";
import type { MenuCounters, WeeklyReport } from "../db/repos/stats.js";
import type { User } from "../db/schema.js";
import type { Logger } from "../logger.js";

/** Telegram allows ~30 messages/s to different chats; stay under it (SPEC §6.2). */
export const REMINDERS_PER_SECOND = 25;

/** Local time of the «стрик в опасности» nudge (SPEC §6.2). */
export const STREAK_NUDGE_TIME = "21:00";
/** Below this the streak is not worth defending — and losing it costs little. */
export const STREAK_NUDGE_MIN_STREAK = 3;
/** No nudge when the daily reminder is already coming this soon: one ping, not two. */
export const STREAK_NUDGE_QUIET_MINUTES = 3 * 60;

/** Monday 10:00 local (SPEC §6.3). Luxon numbers Monday as 1. */
export const WEEKLY_REPORT_TIME = "10:00";
export const WEEKLY_REPORT_WEEKDAY = 1;
/** No report for someone who has not reviewed anything in two weeks. */
export const WEEKLY_REPORT_ACTIVE_DAYS = 14;
export const WEEK_DAYS = 7;

/** Widest real-world UTC offsets, in minutes, at 15-minute granularity. */
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;
const OFFSET_STEP = 15;

const MINUTES_PER_DAY = 24 * 60;

function zoned(now: Date, tz: string): DateTime {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return dt.isValid ? dt : DateTime.fromJSDate(now, { zone: "UTC" });
}

/** Every UTC offset a user could plausibly be on, as a zone string. */
function offsetZones(): string[] {
  const zones: string[] = [];
  for (let offset = MIN_OFFSET; offset <= MAX_OFFSET; offset += OFFSET_STEP) {
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    zones.push(
      `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`,
    );
  }
  return zones;
}

/**
 * Every local "HH:MM" that some timezone could be showing right now. Used to
 * narrow the candidate scan to an indexed equality instead of a full table
 * walk; the exact per-user check happens in `isReminderDue`.
 */
export function candidateLocalTimes(now: Date): string[] {
  const utc = DateTime.fromJSDate(now, { zone: "UTC" }).startOf("minute");
  const times = new Set<string>();
  for (let offset = MIN_OFFSET; offset <= MAX_OFFSET; offset += OFFSET_STEP) {
    times.add(utc.plus({ minutes: offset }).toFormat("HH:mm"));
  }
  return [...times];
}

/**
 * Every learning day that is "today" somewhere on the planet right now — at
 * most three dates. Lets the candidate queries drop users who already studied
 * or were already nudged today without knowing their timezone (SPEC §6.2).
 */
export function candidateDayKeys(now: Date): DayKey[] {
  return [...new Set(offsetZones().map((zone) => learningDayKey(now, zone)))].sort();
}

/** ISO week label of a learning day, e.g. "2026-W36". */
export function isoWeekKey(day: DayKey): string {
  const dt = DateTime.fromISO(day, { zone: "UTC" });
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}

/** ISO weekday of a learning day: Monday is 1. */
export function isoWeekday(day: DayKey): number {
  return DateTime.fromISO(day, { zone: "UTC" }).weekday;
}

/** The ISO weeks some timezone is currently in — at most two. */
export function candidateWeekKeys(now: Date): string[] {
  return [...new Set(candidateDayKeys(now).map(isoWeekKey))];
}

export function localHhMm(now: Date, tz: string): string {
  return zoned(now, tz).toFormat("HH:mm");
}

/** Minutes from one local "HH:MM" to the next occurrence of another, 0…1439. */
export function minutesUntil(from: string, to: string): number {
  const parse = (value: string): number => {
    const [h = "0", m = "0"] = value.split(":");
    return Number(h) * 60 + Number(m);
  };
  return (((parse(to) - parse(from)) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Whole hours left before the learning day flips at 04:00 and the streak burns. */
export function hoursUntilDayEnd(now: Date, tz: string): number {
  const ms = endOfLearningDay(now, tz).getTime() - now.getTime();
  return Math.max(1, Math.round(ms / 3_600_000));
}

/** Shifts an instant by whole days *in the user's zone*, so DST does not skew it. */
function shiftDays(instant: Date, tz: string, days: number): Date {
  return zoned(instant, tz).plus({ days }).toJSDate();
}

/** The closed week a Monday report covers, plus the windows its numbers need. */
export interface WeeklyWindow {
  /** 04:00 of the first day of the reported week. */
  weekStart: Date;
  /** 04:00 of the day the report is sent — the exclusive end of the week. */
  weekEnd: Date;
  /** 04:00 of the first day of the week before it. */
  prevStart: Date;
  /** Everything due before this counts into «ближайшая неделя». */
  forecastEnd: Date;
  /** First and last learning day of the reported week, "YYYY-MM-DD". */
  from: DayKey;
  to: DayKey;
  /** ISO week the report is sent in; the idempotency marker. */
  week: string;
}

export function weeklyWindow(now: Date, tz: string): WeeklyWindow {
  const weekEnd = startOfLearningDay(now, tz);
  const weekStart = shiftDays(weekEnd, tz, -WEEK_DAYS);
  const from = learningDayKey(weekStart, tz);
  return {
    weekStart,
    weekEnd,
    prevStart: shiftDays(weekStart, tz, -WEEK_DAYS),
    forecastEnd: shiftDays(weekEnd, tz, WEEK_DAYS),
    from,
    to: DateTime.fromISO(from, { zone: "UTC" })
      .plus({ days: WEEK_DAYS - 1 })
      .toISODate() as DayKey,
    week: isoWeekKey(learningDayKey(now, tz)),
  };
}

/** Reminders off, blocked or still onboarding: none of the three jobs applies. */
function reachable(user: User): boolean {
  return user.reminderTime !== null && user.blockedAt === null && user.onboardingStep === null;
}

/**
 * Should this user get their daily nudge in this minute?
 * No if reminders are off, the bot is blocked, it is not their reminder minute,
 * a reminder already went out today, or they already studied today.
 */
export function isReminderDue(user: User, now: Date): boolean {
  if (!reachable(user)) return false;
  if (localHhMm(now, user.tz) !== user.reminderTime) return false;
  const today = learningDayKey(now, user.tz);
  if (user.lastRemindedDay === today) return false;
  if (user.streakLastDay === today) return false;
  return true;
}

/**
 * «Стрик в опасности» (SPEC §6.2): 21:00 local, a streak worth losing, nothing
 * studied today, the toggle on, once a day — and never right before the daily
 * reminder, which would land as a second ping within the hour.
 */
export function isStreakNudgeDue(user: User, now: Date): boolean {
  if (!reachable(user) || !user.streakNudge) return false;
  if (user.streak < STREAK_NUDGE_MIN_STREAK) return false;
  if (localHhMm(now, user.tz) !== STREAK_NUDGE_TIME) return false;
  const today = learningDayKey(now, user.tz);
  if (user.lastStreakNudgeDay === today) return false;
  if (user.streakLastDay === today) return false;
  if (minutesUntil(STREAK_NUDGE_TIME, user.reminderTime!) <= STREAK_NUDGE_QUIET_MINUTES) {
    return false;
  }
  return true;
}

/**
 * The Monday report (SPEC §6.3): 10:00 local on a Monday, once per ISO week,
 * for users who reviewed something in the last two weeks. It follows the
 * reminder switch — there is no separate toggle.
 */
export function isWeeklyReportDue(user: User, now: Date): boolean {
  if (!reachable(user)) return false;
  if (localHhMm(now, user.tz) !== WEEKLY_REPORT_TIME) return false;
  const today = learningDayKey(now, user.tz);
  if (isoWeekday(today) !== WEEKLY_REPORT_WEEKDAY) return false;
  if (user.lastWeeklyReportWeek === isoWeekKey(today)) return false;
  if (user.streakLastDay === null) return false;
  return daysBetween(user.streakLastDay, today) <= WEEKLY_REPORT_ACTIVE_DAYS;
}

export type SendOutcome = "sent" | "blocked" | "failed";

export interface ReminderPayload {
  due: number;
  fresh: number;
  minutes: number;
  streak: number;
}

export interface StreakNudgePayload {
  streak: number;
  /** Hours left before the 04:00 boundary. */
  hours: number;
  /** The weekly freeze is still unspent, so the streak survives one miss. */
  freeze: boolean;
}

export interface WeeklyReportPayload {
  from: DayKey;
  to: DayKey;
  reviews: number;
  correct: number;
  newCards: number;
  learned: number;
  daysStudied: number;
  streak: number;
  hardest: string[];
  forecast: number;
  /** Nothing at all this week, but there was last week: the short «вернись». */
  idle: boolean;
}

/** One outgoing message. The renderer turns it into a screen, the sender sends it. */
export type ReminderMessage =
  | ({ kind: "reminder" } & ReminderPayload)
  | ({ kind: "streak_nudge" } & StreakNudgePayload)
  | ({ kind: "weekly_report" } & WeeklyReportPayload);

export interface ReminderPort {
  listCandidates(localTimes: string[]): Promise<User[]>;
  listStreakNudgeCandidates(input: { days: DayKey[]; minStreak: number }): Promise<User[]>;
  listWeeklyReportCandidates(input: { weeks: string[]; activeSince: DayKey }): Promise<User[]>;
  counters(input: {
    userId: number;
    now: Date;
    dayStart: Date;
    defaultNewLimit: number;
  }): Promise<MenuCounters>;
  weekly(input: {
    userId: number;
    weekStart: Date;
    weekEnd: Date;
    prevStart: Date;
    forecastEnd: Date;
  }): Promise<WeeklyReport>;
  markReminded(userId: number, day: DayKey): Promise<void>;
  markStreakNudged(userId: number, day: DayKey): Promise<void>;
  markWeeklyReported(userId: number, week: string): Promise<void>;
  markBlocked(userId: number, at: Date): Promise<void>;
  /** Fire and forget, like everywhere else analytics is written (SPEC §12). */
  record(userId: number, name: EventName, props: Record<string, unknown>): void;
}

export interface ReminderSender {
  send(user: User, message: ReminderMessage): Promise<SendOutcome>;
}

export interface ReminderRunStats {
  checked: number;
  eligible: number;
  sent: number;
  blocked: number;
  skipped: number;
  failed: number;
  /** Of `sent`: streak nudges and weekly reports. */
  nudged: number;
  reported: number;
  /** Pro plans the hourly step downgraded to free (SPEC §9.2). */
  expired: number;
}

export interface ReminderServiceOptions {
  logger: Logger;
  perSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The hourly step: downgrades Pro plans whose `plan_until` has passed and
   * returns how many (SPEC §9.2). It rides on this cron instead of a second
   * timer, and runs on the first tick of every wall-clock hour — so a restart
   * catches up immediately instead of waiting for the next full hour.
   */
  expirePro?: (now: Date) => Promise<number>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * All three scheduled jobs of SPEC §6 — the daily reminder, «стрик в
 * опасности» and the Monday report — run off one cron tick, share one
 * throttle and one 403 handler. Each job is idempotent across restarts: the
 * `last_*` markers on `users` say what already went out.
 */
export function createReminderService(
  port: ReminderPort,
  sender: ReminderSender,
  options: ReminderServiceOptions,
) {
  const perSecond = options.perSecond ?? REMINDERS_PER_SECOND;
  const gap = Math.ceil(1000 / perSecond);
  const sleep = options.sleep ?? defaultSleep;
  /** Epoch hour of the last expiry sweep; null = it has not run yet. */
  let sweptHour: number | null = null;

  return {
    /** One cron tick. Returns counters so the caller can log a single line. */
    async run(now: Date): Promise<ReminderRunStats> {
      const stats: ReminderRunStats = {
        checked: 0,
        eligible: 0,
        sent: 0,
        blocked: 0,
        skipped: 0,
        failed: 0,
        nudged: 0,
        reported: 0,
        expired: 0,
      };

      // 0. Once an hour: Pro plans that ran out (SPEC §9.2). Failing here must
      // not cost anyone their reminder, so it is caught and logged.
      const hour = Math.floor(now.getTime() / 3_600_000);
      if (options.expirePro && sweptHour !== hour) {
        sweptHour = hour;
        try {
          stats.expired = await options.expirePro(now);
          if (stats.expired > 0) options.logger.info({ n: stats.expired }, "pro plans expired");
        } catch (error) {
          options.logger.error({ err: error }, "pro expiry sweep failed");
        }
      }

      let anySent = false;
      /** Paces, sends, and reports whether the message actually landed. */
      const deliver = async (user: User, message: ReminderMessage): Promise<boolean> => {
        if (anySent) await sleep(gap);
        anySent = true;
        const outcome = await sender.send(user, message);
        if (outcome === "blocked") {
          stats.blocked += 1;
          await port.markBlocked(user.id, now);
          return false;
        }
        if (outcome === "failed") {
          stats.failed += 1;
          return false;
        }
        stats.sent += 1;
        return true;
      };

      // 1. Daily reminder (SPEC §6.2).
      const candidates = await port.listCandidates(candidateLocalTimes(now));
      stats.checked += candidates.length;
      for (const user of candidates) {
        if (!isReminderDue(user, now)) continue;
        stats.eligible += 1;
        const today = learningDayKey(now, user.tz);
        const counters = await port.counters({
          userId: user.id,
          now,
          dayStart: startOfLearningDay(now, user.tz),
          defaultNewLimit: user.dailyNewLimit,
        });
        if (counters.due === 0 && counters.newAvailable === 0) {
          stats.skipped += 1;
          // Remember it anyway so we do not re-check this user every minute.
          await port.markReminded(user.id, today);
          continue;
        }
        const sent = await deliver(user, {
          kind: "reminder",
          due: counters.due,
          fresh: counters.newAvailable,
          minutes: estimateMinutes(counters.due + counters.newAvailable),
          streak: user.streak,
        });
        if (!sent) continue;
        await port.markReminded(user.id, today);
        port.record(user.id, "reminder_sent", { streak: user.streak });
      }

      // 2. «Стрик в опасности» (SPEC §6.2).
      const days = candidateDayKeys(now);
      const endangered = await port.listStreakNudgeCandidates({
        days,
        minStreak: STREAK_NUDGE_MIN_STREAK,
      });
      stats.checked += endangered.length;
      for (const user of endangered) {
        if (!isStreakNudgeDue(user, now)) continue;
        stats.eligible += 1;
        const today = learningDayKey(now, user.tz);
        const sent = await deliver(user, {
          kind: "streak_nudge",
          streak: user.streak,
          hours: hoursUntilDayEnd(now, user.tz),
          freeze: freezeAvailable(
            {
              streak: user.streak,
              lastDay: user.streakLastDay,
              freezeDay: user.streakFreezeDay,
            },
            today,
          ),
        });
        if (!sent) continue;
        stats.nudged += 1;
        await port.markStreakNudged(user.id, today);
        port.record(user.id, "streak_nudge_sent", { streak: user.streak });
      }

      // 3. Monday report (SPEC §6.3).
      const weeks = candidateWeekKeys(now);
      const activeSince = DateTime.fromISO(days[0] ?? "1970-01-01", { zone: "UTC" })
        .minus({ days: WEEKLY_REPORT_ACTIVE_DAYS })
        .toISODate() as DayKey;
      const readers = await port.listWeeklyReportCandidates({ weeks, activeSince });
      stats.checked += readers.length;
      for (const user of readers) {
        if (!isWeeklyReportDue(user, now)) continue;
        stats.eligible += 1;
        const window = weeklyWindow(now, user.tz);
        const totals = await port.weekly({ userId: user.id, ...window });
        const idle = totals.reviews === 0 && totals.newCards === 0;
        // Nothing this week and nothing the week before: there is no report to
        // write. Mark the week anyway, or every minute of it re-runs the query.
        if (idle && totals.prevReviews === 0) {
          stats.skipped += 1;
          await port.markWeeklyReported(user.id, window.week);
          continue;
        }
        const sent = await deliver(user, {
          kind: "weekly_report",
          from: window.from,
          to: window.to,
          reviews: totals.reviews,
          correct: totals.correct,
          newCards: totals.newCards,
          learned: totals.learned,
          daysStudied: totals.daysStudied,
          streak: user.streak,
          hardest: totals.hardest,
          forecast: totals.forecast,
          idle,
        });
        if (!sent) continue;
        stats.reported += 1;
        await port.markWeeklyReported(user.id, window.week);
        port.record(user.id, "weekly_report_sent", {
          reviews: totals.reviews,
          newCards: totals.newCards,
        });
      }

      return stats;
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;

import { DateTime } from "luxon";
import { estimateMinutes } from "../bot/format.js";
import { learningDayKey, startOfLearningDay } from "../core/streak.js";
import type { MenuCounters } from "../db/repos/stats.js";
import type { User } from "../db/schema.js";
import type { Logger } from "../logger.js";

/** Telegram allows ~30 messages/s to different chats; stay under it (SPEC §6.2). */
export const REMINDERS_PER_SECOND = 25;

/** Widest real-world UTC offsets, in minutes, at 15-minute granularity. */
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;
const OFFSET_STEP = 15;

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

export function localHhMm(now: Date, tz: string): string {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return (dt.isValid ? dt : DateTime.fromJSDate(now, { zone: "UTC" })).toFormat("HH:mm");
}

/**
 * Should this user get their daily nudge in this minute?
 * No if reminders are off, the bot is blocked, it is not their reminder minute,
 * a reminder already went out today, or they already studied today.
 */
export function isReminderDue(user: User, now: Date): boolean {
  if (!user.reminderTime || user.blockedAt !== null) return false;
  if (user.onboardingStep !== null) return false;
  if (localHhMm(now, user.tz) !== user.reminderTime) return false;
  const today = learningDayKey(now, user.tz);
  if (user.lastRemindedDay === today) return false;
  if (user.streakLastDay === today) return false;
  return true;
}

export type SendOutcome = "sent" | "blocked" | "failed";

export interface ReminderPayload {
  due: number;
  fresh: number;
  minutes: number;
  streak: number;
}

export interface ReminderPort {
  listCandidates(localTimes: string[]): Promise<User[]>;
  counters(input: {
    userId: number;
    now: Date;
    dayStart: Date;
    defaultNewLimit: number;
  }): Promise<MenuCounters>;
  markReminded(userId: number, day: string): Promise<void>;
  markBlocked(userId: number, at: Date): Promise<void>;
}

export interface ReminderSender {
  send(user: User, payload: ReminderPayload): Promise<SendOutcome>;
}

export interface ReminderRunStats {
  checked: number;
  eligible: number;
  sent: number;
  blocked: number;
  skipped: number;
  failed: number;
}

export interface ReminderServiceOptions {
  logger: Logger;
  perSecond?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createReminderService(
  port: ReminderPort,
  sender: ReminderSender,
  options: ReminderServiceOptions,
) {
  const perSecond = options.perSecond ?? REMINDERS_PER_SECOND;
  const gap = Math.ceil(1000 / perSecond);
  const sleep = options.sleep ?? defaultSleep;

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
      };
      const candidates = await port.listCandidates(candidateLocalTimes(now));
      stats.checked = candidates.length;

      let first = true;
      for (const user of candidates) {
        if (!isReminderDue(user, now)) continue;
        stats.eligible += 1;
        const counters = await port.counters({
          userId: user.id,
          now,
          dayStart: startOfLearningDay(now, user.tz),
          defaultNewLimit: user.dailyNewLimit,
        });
        if (counters.due === 0 && counters.newAvailable === 0) {
          stats.skipped += 1;
          // Remember it anyway so we do not re-check this user every minute.
          await port.markReminded(user.id, learningDayKey(now, user.tz));
          continue;
        }
        if (!first) await sleep(gap);
        first = false;
        const outcome = await sender.send(user, {
          due: counters.due,
          fresh: counters.newAvailable,
          minutes: estimateMinutes(counters.due + counters.newAvailable),
          streak: user.streak,
        });
        if (outcome === "blocked") {
          stats.blocked += 1;
          await port.markBlocked(user.id, now);
          continue;
        }
        if (outcome === "failed") {
          stats.failed += 1;
          continue;
        }
        stats.sent += 1;
        await port.markReminded(user.id, learningDayKey(now, user.tz));
      }
      return stats;
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;

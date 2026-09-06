import { and, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { StreakUpdate } from "../../core/streak.js";
import type { Database } from "../index.js";
import {
  cards,
  knownWords,
  type NewUser,
  type PendingPayload,
  sessions,
  type User,
  users,
} from "../schema.js";

export function createUsersRepo(db: Database) {
  return {
    async findByTgId(tgId: number): Promise<User | null> {
      const [row] = await db.select().from(users).where(eq(users.tgId, tgId)).limit(1);
      return row ?? null;
    },

    async findById(id: number): Promise<User | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },

    /** Returns the existing user or creates one on first contact. */
    async ensure(values: NewUser): Promise<User> {
      const [row] = await db
        .insert(users)
        .values(values)
        .onConflictDoUpdate({
          target: users.tgId,
          set: { updatedAt: new Date() },
        })
        .returning();
      return row!;
    },

    async update(id: number, patch: Partial<NewUser>): Promise<User> {
      const [row] = await db
        .update(users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return row!;
    },

    async saveStreak(id: number, streak: StreakUpdate): Promise<void> {
      await db
        .update(users)
        .set({
          streak: streak.streak,
          streakLastDay: streak.lastDay,
          streakFreezeDay: streak.freezeDay,
          streakBest: sql`greatest(${users.streakBest}, ${streak.streak})`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
    },

    /** Arms the "next text message means X" state; TTL is 10 minutes (SPEC §11). */
    async setPendingInput(
      id: number,
      input: string | null,
      options: { ttlMs?: number; payload?: PendingPayload | null; now?: Date } = {},
    ): Promise<User> {
      const now = options.now ?? new Date();
      const ttl = options.ttlMs ?? 10 * 60_000;
      return this.update(id, {
        pendingInput: input,
        pendingInputExpiresAt: input === null ? null : new Date(now.getTime() + ttl),
        // Clearing the question drops the draft with it, unless the caller
        // passes a payload of its own — the add flow keeps its revision
        // counter there, and that counter has to stay monotonic (SPEC §4.1).
        pendingPayload: options.payload ?? null,
      });
    },

    async markBlocked(id: number, at: Date): Promise<void> {
      await db.update(users).set({ blockedAt: at }).where(eq(users.id, id));
    },

    async clearBlocked(id: number): Promise<void> {
      await db.update(users).set({ blockedAt: null }).where(eq(users.id, id));
    },

    async markReminded(id: number, day: string): Promise<void> {
      await db.update(users).set({ lastRemindedDay: day }).where(eq(users.id, id));
    },

    async markStreakNudged(id: number, day: string): Promise<void> {
      await db.update(users).set({ lastStreakNudgeDay: day }).where(eq(users.id, id));
    },

    async markWeeklyReported(id: number, week: string): Promise<void> {
      await db.update(users).set({ lastWeeklyReportWeek: week }).where(eq(users.id, id));
    },

    /**
     * Users whose local reminder time could be firing right now. The exact
     * timezone comparison happens in `services/reminderService.ts`; this only
     * narrows the scan to the handful of "HH:MM" values that are plausible.
     */
    listReminderCandidates(localTimes: string[]): Promise<User[]> {
      if (localTimes.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(users)
        .where(
          and(
            isNotNull(users.reminderTime),
            isNull(users.blockedAt),
            isNull(users.onboardingStep),
            inArray(users.reminderTime, localTimes),
          ),
        );
    },

    /**
     * Candidates for «стрик в опасности» (SPEC §6.2). The 21:00 comparison
     * needs the timezone and happens in `services/reminderService.ts`; here we
     * drop everyone who can never qualify — reminders off, blocked, too short a
     * streak, the toggle off — plus everyone who already studied or was already
     * nudged on any learning day that is "today" somewhere on the planet.
     */
    listStreakNudgeCandidates(input: { days: string[]; minStreak: number }): Promise<User[]> {
      if (input.days.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(users)
        .where(
          and(
            isNotNull(users.reminderTime),
            eq(users.streakNudge, true),
            isNull(users.blockedAt),
            isNull(users.onboardingStep),
            gte(users.streak, input.minStreak),
            or(isNull(users.lastStreakNudgeDay), notInArray(users.lastStreakNudgeDay, input.days)),
            or(isNull(users.streakLastDay), notInArray(users.streakLastDay, input.days)),
          ),
        );
    },

    /**
     * Candidates for the Monday report (SPEC §6.3): reminders on, not blocked,
     * a review in the last 14 days (`streak_last_day` is written by every
     * session) and no report yet for the ISO week they are currently in.
     */
    listWeeklyReportCandidates(input: { weeks: string[]; activeSince: string }): Promise<User[]> {
      if (input.weeks.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(users)
        .where(
          and(
            isNotNull(users.reminderTime),
            isNull(users.blockedAt),
            isNull(users.onboardingStep),
            gte(users.streakLastDay, input.activeSince),
            or(
              isNull(users.lastWeeklyReportWeek),
              notInArray(users.lastWeeklyReportWeek, input.weeks),
            ),
          ),
        );
    },

    /**
     * Paid plans whose time is up (SPEC §9.2). `lifetime` has no `plan_until`
     * and never shows up here; a cancelled Stars subscription simply stops
     * renewing, so an expired date is all we ever get to see.
     */
    listExpiredPlans(now: Date, limit: number): Promise<User[]> {
      return db
        .select()
        .from(users)
        .where(and(eq(users.plan, "pro"), isNotNull(users.planUntil), lt(users.planUntil, now)))
        .limit(limit);
    },

    async deleteById(id: number): Promise<void> {
      await db.delete(users).where(eq(users.id, id));
    },

    /**
     * Wipes learning progress but keeps the account, its settings, deck
     * subscriptions and own notes: cards (review logs cascade), sessions,
     * streak and the reminder marker.
     */
    async resetProgress(id: number): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.userId, id));
        await tx.delete(cards).where(eq(cards.userId, id));
        // Switched-off words are progress too — a reset user meets them again.
        await tx.delete(knownWords).where(eq(knownWords.userId, id));
        await tx
          .update(users)
          .set({
            streak: 0,
            streakBest: 0,
            streakLastDay: null,
            streakFreezeDay: null,
            lastRemindedDay: null,
            lastStreakNudgeDay: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));
      });
    },

    async countAll(): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      return row?.count ?? 0;
    },

    async countCreatedSince(since: Date): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(gte(users.createdAt, since));
      return row?.count ?? 0;
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;

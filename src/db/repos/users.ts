import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { StreakUpdate } from "../../core/streak.js";
import type { Database } from "../index.js";
import { type NewUser, type PendingPayload, type User, users } from "../schema.js";

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
        pendingPayload: input === null ? null : (options.payload ?? null),
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

    async deleteById(id: number): Promise<void> {
      await db.delete(users).where(eq(users.id, id));
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

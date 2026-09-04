import { eq } from "drizzle-orm";
import type { StreakUpdate } from "../../core/streak.js";
import type { Database } from "../index.js";
import { type NewUser, type User, users } from "../schema.js";

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
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;

import { and, desc, eq } from "drizzle-orm";
import type { QueueItem } from "../../core/queue.js";
import type { Database } from "../index.js";
import { type Session, type SessionStats, sessions } from "../schema.js";

export const emptyStats = (): SessionStats => ({
  reviewed: 0,
  again: 0,
  hard: 0,
  good: 0,
  easy: 0,
  newLearned: 0,
});

export function createSessionsRepo(db: Database) {
  return {
    async findActive(userId: number): Promise<Session | null> {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.status, "active")))
        .limit(1);
      return row ?? null;
    },

    async findById(id: number): Promise<Session | null> {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row ?? null;
    },

    async findLast(userId: number): Promise<Session | null> {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.startedAt))
        .limit(1);
      return row ?? null;
    },

    async create(input: {
      userId: number;
      deckId: number | null;
      chatId: number;
      messageId?: number | null;
      queue: QueueItem[];
    }): Promise<Session> {
      const [row] = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          deckId: input.deckId,
          chatId: input.chatId,
          messageId: input.messageId ?? null,
          queue: input.queue,
          position: 0,
          status: "active",
          stats: emptyStats(),
        })
        .returning();
      return row!;
    },

    async save(
      id: number,
      patch: Partial<Pick<Session, "queue" | "position" | "messageId" | "stats">>,
    ): Promise<void> {
      await db.update(sessions).set(patch).where(eq(sessions.id, id));
    },

    async finish(id: number, status: "finished" | "abandoned" = "finished"): Promise<void> {
      await db.update(sessions).set({ status, finishedAt: new Date() }).where(eq(sessions.id, id));
    },
  };
}

export type SessionsRepo = ReturnType<typeof createSessionsRepo>;

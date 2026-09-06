import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { events } from "../schema.js";

/** Event names used across the bot (SPEC §12). */
export type EventName =
  | "start"
  | "onboarding_done"
  | "session_start"
  | "review"
  | "session_end"
  | "word_added"
  | "text_extracted"
  | "text_words_added"
  | "word_generated"
  | "word_generation_failed"
  | "deck_subscribed"
  | "deck_unsubscribed"
  | "deck_created"
  | "deck_deleted"
  | "reminder_sent"
  | "reminder_clicked"
  | "pro_screen"
  | "payment"
  | "note_reported"
  | "word_known"
  | "deck_restored"
  | "account_deleted"
  | "blocked";

export function createEventsRepo(db: Database) {
  return {
    async insert(input: {
      userId: number | null;
      name: EventName;
      props?: Record<string, unknown>;
      at?: Date;
    }): Promise<void> {
      await db.insert(events).values({
        userId: input.userId,
        name: input.name,
        props: input.props ?? null,
        ...(input.at ? { at: input.at } : {}),
      });
    },

    /**
     * How many cards this user actually had generated today (SPEC §9.1). Cache
     * hits carry `cached: true` and do not count — they cost nothing.
     */
    async countGenerationsSince(userId: number, since: Date): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.name, "word_generated"),
            gte(events.at, since),
            sql`coalesce(${events.props} ->> 'cached', 'false') = 'false'`,
          ),
        );
      return row?.count ?? 0;
    },

    /** How many events of one kind this user produced since `since` (SPEC §9.1). */
    async countUserEventsSince(userId: number, name: EventName, since: Date): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.userId, userId), eq(events.name, name), gte(events.at, since)));
      return row?.count ?? 0;
    },

    async countSince(name: EventName, since: Date): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.name, name), gte(events.at, since)));
      return row?.count ?? 0;
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;

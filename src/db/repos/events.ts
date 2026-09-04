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
  | "deck_subscribed"
  | "deck_unsubscribed"
  | "deck_created"
  | "deck_deleted"
  | "reminder_sent"
  | "reminder_clicked"
  | "pro_screen"
  | "payment"
  | "note_reported"
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

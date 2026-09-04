import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userPlan = pgEnum("user_plan", ["free", "pro", "lifetime"]);
export const deckKind = pgEnum("deck_kind", ["builtin", "user", "shared"]);
export const cardMode = pgEnum("card_mode", ["recognition", "recall"]);
export const sessionStatus = pgEnum("session_status", ["active", "finished", "abandoned"]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    tgId: bigint("tg_id", { mode: "number" }).notNull(),
    uiLang: text("ui_lang").notNull().default("ru"),
    tz: text("tz").notNull().default("UTC"),
    dailyNewLimit: integer("daily_new_limit").notNull().default(10),
    /** Local "HH:MM" for the daily reminder, null = reminders off. */
    reminderTime: text("reminder_time"),
    plan: userPlan("plan").notNull().default("free"),
    planUntil: timestamp("plan_until", { withTimezone: true }),
    streak: integer("streak").notNull().default(0),
    /** Learning day (04:00 boundary, user tz) of the last session, "YYYY-MM-DD". */
    streakLastDay: date("streak_last_day"),
    /** Learning day on which the weekly streak freeze was last spent. */
    streakFreezeDay: date("streak_freeze_day"),
    langFrom: text("lang_from"),
    langTo: text("lang_to"),
    onboardingStep: text("onboarding_step"),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_tg_id_key").on(t.tgId)],
);

export const decks = pgTable(
  "decks",
  {
    id: serial("id").primaryKey(),
    /** null = builtin deck shared by every user. */
    ownerId: integer("owner_id").references(() => users.id, { onDelete: "cascade" }),
    /** Stable identifier for builtin decks, null for user decks. */
    slug: text("slug"),
    title: text("title").notNull(),
    description: text("description"),
    langFrom: text("lang_from").notNull(),
    langTo: text("lang_to").notNull(),
    kind: deckKind("kind").notNull().default("user"),
    /** CEFR-ish level label, e.g. "A1". */
    level: text("level"),
    isPublic: boolean("is_public").notNull().default(false),
    createdAt,
  },
  (t) => [uniqueIndex("decks_slug_key").on(t.slug), index("decks_owner_id_idx").on(t.ownerId)],
);

export const notes = pgTable(
  "notes",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    transcription: text("transcription"),
    example: text("example"),
    exampleTr: text("example_tr"),
    audioFileId: text("audio_file_id"),
    imageFileId: text("image_file_id"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Order inside the deck; frequency lists are already sorted by usefulness. */
    position: integer("position").notNull().default(0),
    createdAt,
  },
  (t) => [
    uniqueIndex("notes_deck_id_front_key").on(t.deckId, t.front),
    index("notes_deck_id_position_idx").on(t.deckId, t.position),
  ],
);

export const cards = pgTable(
  "cards",
  {
    id: serial("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: cardMode("mode").notNull(),
    /** ts-fsrs State: 0 new, 1 learning, 2 review, 3 relearning. */
    state: integer("state").notNull().default(0),
    stability: real("stability").notNull().default(0),
    difficulty: real("difficulty").notNull().default(0),
    due: timestamp("due", { withTimezone: true }).notNull(),
    lastReview: timestamp("last_review", { withTimezone: true }),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    /** Index into the FSRS (re)learning steps. */
    learningSteps: integer("learning_steps").notNull().default(0),
    suspended: boolean("suspended").notNull().default(false),
    createdAt,
  },
  (t) => [
    uniqueIndex("cards_note_user_mode_key").on(t.noteId, t.userId, t.mode),
    index("cards_user_due_idx").on(t.userId, t.due),
  ],
);

export const reviewLogs = pgTable(
  "review_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 1 Again, 2 Hard, 3 Good, 4 Easy. */
    rating: integer("rating").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    // Full snapshot of the card before the review: enough to undo it exactly.
    stateBefore: integer("state_before").notNull(),
    stabilityBefore: real("stability_before").notNull(),
    difficultyBefore: real("difficulty_before").notNull(),
    dueBefore: timestamp("due_before", { withTimezone: true }).notNull(),
    lastReviewBefore: timestamp("last_review_before", { withTimezone: true }),
    repsBefore: integer("reps_before").notNull(),
    lapsesBefore: integer("lapses_before").notNull(),
    learningStepsBefore: integer("learning_steps_before").notNull(),
    /** Days between the previous review and this one (fsrs-optimizer input). */
    elapsedDays: integer("elapsed_days").notNull(),
    /** cards.elapsed_days before the review; only used to restore it on undo. */
    elapsedDaysBefore: integer("elapsed_days_before").notNull().default(0),
    /** Interval the card was scheduled for before this review. */
    scheduledDays: integer("scheduled_days").notNull(),
  },
  (t) => [
    index("review_logs_user_reviewed_at_idx").on(t.userId, t.reviewedAt),
    index("review_logs_card_id_idx").on(t.cardId),
  ],
);

export const userDecks = pgTable(
  "user_decks",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deckId: integer("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    /** null = fall back to users.daily_new_limit. */
    newPerDay: integer("new_per_day"),
    modes: cardMode("modes").array().notNull().default(sql`'{recognition}'::card_mode[]`),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deckId] })],
);

export type QueueItem = { cardId: number; isNew: boolean };

export type SessionStats = {
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  newLearned: number;
};

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** null = cards from every subscribed deck. */
    deckId: integer("deck_id").references(() => decks.id, { onDelete: "set null" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    /** The single message the session is rendered into. */
    messageId: bigint("message_id", { mode: "number" }),
    status: sessionStatus("status").notNull().default("active"),
    queue: jsonb("queue").$type<QueueItem[]>().notNull(),
    position: integer("position").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stats: jsonb("stats").$type<SessionStats>().notNull(),
  },
  (t) => [
    uniqueIndex("sessions_one_active_per_user").on(t.userId).where(sql`${t.status} = 'active'`),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const generatedCache = pgTable("generated_cache", {
  /** `${kind}:${langFrom}:${langTo}:${normalizedWord}` */
  key: text("key").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt,
});

export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tgChargeId: text("tg_charge_id").notNull(),
    stars: integer("stars").notNull(),
    product: text("product").notNull(),
    subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex("payments_tg_charge_id_key").on(t.tgChargeId),
    index("payments_user_id_idx").on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Deck = typeof decks.$inferSelect;
export type NewDeck = typeof decks.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type ReviewLog = typeof reviewLogs.$inferSelect;
export type NewReviewLog = typeof reviewLogs.$inferInsert;
export type UserDeck = typeof userDecks.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type CardMode = (typeof cardMode.enumValues)[number];

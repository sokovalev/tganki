CREATE TYPE "public"."card_mode" AS ENUM('recognition', 'recall');--> statement-breakpoint
CREATE TYPE "public"."deck_kind" AS ENUM('builtin', 'user', 'shared');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'finished', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."user_plan" AS ENUM('free', 'pro', 'lifetime');--> statement-breakpoint
CREATE TABLE "cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"note_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"mode" "card_mode" NOT NULL,
	"state" integer DEFAULT 0 NOT NULL,
	"stability" real DEFAULT 0 NOT NULL,
	"difficulty" real DEFAULT 0 NOT NULL,
	"due" timestamp with time zone NOT NULL,
	"last_review" timestamp with time zone,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer,
	"slug" text,
	"title" text NOT NULL,
	"description" text,
	"lang_from" text NOT NULL,
	"lang_to" text NOT NULL,
	"kind" "deck_kind" DEFAULT 'user' NOT NULL,
	"level" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"deck_id" integer NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"transcription" text,
	"example" text,
	"example_tr" text,
	"audio_file_id" text,
	"image_file_id" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tg_charge_id" text NOT NULL,
	"stars" integer NOT NULL,
	"product" text NOT NULL,
	"subscription_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"card_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"state_before" integer NOT NULL,
	"stability_before" real NOT NULL,
	"difficulty_before" real NOT NULL,
	"due_before" timestamp with time zone NOT NULL,
	"last_review_before" timestamp with time zone,
	"reps_before" integer NOT NULL,
	"lapses_before" integer NOT NULL,
	"learning_steps_before" integer NOT NULL,
	"elapsed_days" integer NOT NULL,
	"elapsed_days_before" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"deck_id" integer,
	"chat_id" bigint NOT NULL,
	"message_id" bigint,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"queue" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_decks" (
	"user_id" integer NOT NULL,
	"deck_id" integer NOT NULL,
	"new_per_day" integer,
	"modes" "card_mode"[] DEFAULT '{recognition}'::card_mode[] NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_decks_user_id_deck_id_pk" PRIMARY KEY("user_id","deck_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_id" bigint NOT NULL,
	"ui_lang" text DEFAULT 'ru' NOT NULL,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"daily_new_limit" integer DEFAULT 10 NOT NULL,
	"reminder_time" text,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"plan_until" timestamp with time zone,
	"streak" integer DEFAULT 0 NOT NULL,
	"streak_last_day" date,
	"streak_freeze_day" date,
	"lang_from" text,
	"lang_to" text,
	"onboarding_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decks" ADD CONSTRAINT "user_decks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_decks" ADD CONSTRAINT "user_decks_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cards_note_user_mode_key" ON "cards" USING btree ("note_id","user_id","mode");--> statement-breakpoint
CREATE INDEX "cards_user_due_idx" ON "cards" USING btree ("user_id","due");--> statement-breakpoint
CREATE UNIQUE INDEX "decks_slug_key" ON "decks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "decks_owner_id_idx" ON "decks" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_deck_id_front_key" ON "notes" USING btree ("deck_id","front");--> statement-breakpoint
CREATE INDEX "notes_deck_id_position_idx" ON "notes" USING btree ("deck_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tg_charge_id_key" ON "payments" USING btree ("tg_charge_id");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "review_logs_user_reviewed_at_idx" ON "review_logs" USING btree ("user_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "review_logs_card_id_idx" ON "review_logs" USING btree ("card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_active_per_user" ON "sessions" USING btree ("user_id") WHERE "sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tg_id_key" ON "users" USING btree ("tg_id");
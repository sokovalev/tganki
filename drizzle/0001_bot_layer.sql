CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"props" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"note_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "buried_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "public_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "message_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "streak_best" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_reminded_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_intervals" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "desired_retention" real DEFAULT 0.9 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_input" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_input_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_payload" jsonb;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reports" ADD CONSTRAINT "note_reports_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reports" ADD CONSTRAINT "note_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_name_at_idx" ON "events" USING btree ("name","at");--> statement-breakpoint
CREATE INDEX "note_reports_note_id_idx" ON "note_reports" USING btree ("note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decks_public_id_key" ON "decks" USING btree ("public_id");
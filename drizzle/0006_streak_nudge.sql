ALTER TABLE "users" ADD COLUMN "streak_nudge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_streak_nudge_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_weekly_report_week" text;
CREATE TYPE "public"."new_card_style" AS ENUM('reveal', 'choice');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "new_card_style" "new_card_style" DEFAULT 'choice' NOT NULL;
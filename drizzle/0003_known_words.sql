CREATE TABLE "known_words" (
	"user_id" integer NOT NULL,
	"lang_from" text NOT NULL,
	"front_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "known_words_user_id_lang_from_front_norm_pk" PRIMARY KEY("user_id","lang_from","front_norm")
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "known_words" ADD CONSTRAINT "known_words_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_front_norm_idx" ON "notes" USING btree (lower(btrim(regexp_replace(normalize(front, NFC), '\s+', ' ', 'g'))));
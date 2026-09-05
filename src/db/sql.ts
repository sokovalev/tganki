import { type SQL, sql } from "drizzle-orm";

/**
 * Binds a timestamp inside a raw `sql` template.
 *
 * Drizzle's raw SQL goes to postgres.js as an untyped parameter list, and the
 * driver cannot serialize a bare `Date` there (it throws
 * "The 'string' argument must be of type string ... Received an instance of
 * Date"). Sending the ISO string with an explicit cast keeps the planner happy
 * and the value exact. The query builder handles Dates by itself, so this is
 * only needed in hand-written SQL.
 */
export function ts(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`;
}

/**
 * Normalized word key: NFC, whitespace collapsed and trimmed, lowercased.
 * Used to decide that two `notes.front` values are the same word across decks
 * (SPEC §3.7). `known_words.front_norm` is written with the very same
 * expression, so the two always agree.
 */
export function frontNorm(value: SQL): SQL {
  return sql`lower(btrim(regexp_replace(normalize(${value}, NFC), '\\s+', ' ', 'g')))`;
}

/**
 * "This note is not a word the user already switched off, and not one they are
 * already learning through another deck" (SPEC §3.7). `note` and `deck` are
 * table aliases visible in the surrounding query.
 */
export function notKnownOrDuplicate(input: { userId: number; note: string; deck: string }): SQL {
  const note = sql.raw(input.note);
  const deck = sql.raw(input.deck);
  const front = frontNorm(sql`${note}.front`);
  return sql`(
    not exists (
      select 1 from known_words kw
       where kw.user_id = ${input.userId}
         and kw.lang_from = ${deck}.lang_from
         and kw.front_norm = ${front}
    )
    and not exists (
      select 1 from cards dupc
        join notes dupn on dupn.id = dupc.note_id
        join decks dupd on dupd.id = dupn.deck_id
       where dupc.user_id = ${input.userId}
         and dupn.id <> ${note}.id
         and dupd.lang_from = ${deck}.lang_from
         and ${frontNorm(sql`dupn.front`)} = ${front}
    ))`;
}

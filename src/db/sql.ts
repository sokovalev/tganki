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

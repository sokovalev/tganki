import { sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { ts } from "../sql.js";
import { MATURE_STABILITY_DAYS } from "./decks.js";

export interface MenuCounters {
  /** Cards ready for review right now. */
  due: number;
  /** New cards the user may still start today. */
  newAvailable: number;
}

export interface ReviewWindows {
  todayReviews: number;
  todayCorrect: number;
  weekReviews: number;
  weekCorrect: number;
  weekNew: number;
}

export interface CardBuckets {
  /** (note, mode) pairs never started. */
  fresh: number;
  /** FSRS learning + relearning. */
  learning: number;
  /** In review but not yet mature. */
  review: number;
  /** Stability ≥ 21 days. */
  mature: number;
}

export interface Forecast {
  tomorrow: number;
  week: number;
}

export interface AdminSummary {
  usersTotal: number;
  usersToday: number;
  sessionsToday: number;
  reviewsToday: number;
}

/**
 * Notes (times modes) in subscribed decks that the user has not started yet,
 * grouped by deck. Shared by the menu counters and the stats screen.
 */
const availableCte = (userId: number, now: Date) => sql`
  subs as (
    select ud.deck_id, ud.modes, ud.user_id, ud.new_per_day
    from user_decks ud where ud.user_id = ${userId}
  ),
  avail as (
    select s.deck_id, count(*)::int as c
    from subs s
    join notes n on n.deck_id = s.deck_id
    cross join lateral unnest(s.modes) as m(mode)
    left join cards c on c.note_id = n.id and c.user_id = s.user_id and c.mode = m.mode
    where (c.id is null or (c.state = 0 and c.suspended = false))
      and (c.id is null or c.buried_until is null or c.buried_until <= ${ts(now)})
    group by s.deck_id
  )`;

export function createStatsRepo(db: Database) {
  return {
    /**
     * The two numbers on the main menu, in a single round trip: overdue cards
     * and how many new ones today's per-deck allowance still permits.
     */
    async menuCounters(input: {
      userId: number;
      now: Date;
      dayStart: Date;
      defaultNewLimit: number;
    }): Promise<MenuCounters> {
      const rows = (await db.execute(sql`
        with ${availableCte(input.userId, input.now)}
        select
          (select count(*) from cards c
             join notes n on n.id = c.note_id
             join subs s on s.deck_id = n.deck_id
            where c.user_id = ${input.userId} and c.suspended = false and c.state <> 0
              and c.due <= ${ts(input.now)}
              and (c.buried_until is null or c.buried_until <= ${ts(input.now)}))::int as due,
          (select coalesce(sum(least(coalesce(a.c, 0),
                                     coalesce(s.new_per_day, ${input.defaultNewLimit}))), 0)
             from subs s left join avail a on a.deck_id = s.deck_id)::int as capped,
          (select coalesce(sum(coalesce(s.new_per_day, ${input.defaultNewLimit})), 0)
             from subs s)::int as cap_total,
          (select count(*) from review_logs rl
            where rl.user_id = ${input.userId} and rl.state_before = 0
              and rl.reviewed_at >= ${ts(input.dayStart)})::int as introduced
      `)) as unknown as Array<{
        due: number;
        capped: number;
        cap_total: number;
        introduced: number;
      }>;
      const row = rows[0];
      const capped = Number(row?.capped ?? 0);
      const left = Math.max(0, Number(row?.cap_total ?? 0) - Number(row?.introduced ?? 0));
      return { due: Number(row?.due ?? 0), newAvailable: Math.min(capped, left) };
    },

    async reviewWindows(input: {
      userId: number;
      dayStart: Date;
      weekStart: Date;
    }): Promise<ReviewWindows> {
      const rows = (await db.execute(sql`
        select
          count(*) filter (where reviewed_at >= ${ts(input.dayStart)})::int as today_reviews,
          count(*) filter (where reviewed_at >= ${ts(input.dayStart)} and rating > 1)::int
            as today_correct,
          count(*)::int as week_reviews,
          count(*) filter (where rating > 1)::int as week_correct,
          count(*) filter (where state_before = 0)::int as week_new
        from review_logs
        where user_id = ${input.userId} and reviewed_at >= ${ts(input.weekStart)}
      `)) as unknown as Array<Record<string, number>>;
      const row = rows[0] ?? {};
      return {
        todayReviews: Number(row.today_reviews ?? 0),
        todayCorrect: Number(row.today_correct ?? 0),
        weekReviews: Number(row.week_reviews ?? 0),
        weekCorrect: Number(row.week_correct ?? 0),
        weekNew: Number(row.week_new ?? 0),
      };
    },

    async cardBuckets(input: { userId: number; now: Date }): Promise<CardBuckets> {
      const rows = (await db.execute(sql`
        with ${availableCte(input.userId, input.now)}
        select
          (select coalesce(sum(c), 0) from avail)::int as fresh,
          count(*) filter (where c.state in (1, 3))::int as learning,
          count(*) filter (where c.state = 2 and c.stability < ${MATURE_STABILITY_DAYS})::int
            as review,
          count(*) filter (where c.stability >= ${MATURE_STABILITY_DAYS})::int as mature
        from cards c
        join notes n on n.id = c.note_id
        join subs s on s.deck_id = n.deck_id
        where c.user_id = ${input.userId} and c.suspended = false
      `)) as unknown as Array<Record<string, number>>;
      const row = rows[0] ?? {};
      return {
        fresh: Number(row.fresh ?? 0),
        learning: Number(row.learning ?? 0),
        review: Number(row.review ?? 0),
        mature: Number(row.mature ?? 0),
      };
    },

    async forecast(input: { userId: number; dayEnd: Date; weekEnd: Date }): Promise<Forecast> {
      const tomorrowEnd = new Date(input.dayEnd.getTime() + 24 * 60 * 60 * 1000);
      const rows = (await db.execute(sql`
        select
          count(*) filter (where c.due > ${ts(input.dayEnd)} and c.due <= ${ts(tomorrowEnd)})::int
            as tomorrow,
          count(*) filter (where c.due <= ${ts(input.weekEnd)})::int as week
        from cards c
        join notes n on n.id = c.note_id
        join user_decks ud on ud.deck_id = n.deck_id and ud.user_id = c.user_id
        where c.user_id = ${input.userId} and c.suspended = false and c.state <> 0
          and c.due > ${ts(input.dayEnd)}
      `)) as unknown as Array<Record<string, number>>;
      const row = rows[0] ?? {};
      return { tomorrow: Number(row.tomorrow ?? 0), week: Number(row.week ?? 0) };
    },

    async adminSummary(since: Date): Promise<AdminSummary> {
      const rows = (await db.execute(sql`
        select
          (select count(*) from users)::int as users_total,
          (select count(*) from users where created_at >= ${ts(since)})::int as users_today,
          (select count(*) from sessions where started_at >= ${ts(since)})::int as sessions_today,
          (select count(*) from review_logs where reviewed_at >= ${ts(since)})::int as reviews_today
      `)) as unknown as Array<Record<string, number>>;
      const row = rows[0] ?? {};
      return {
        usersTotal: Number(row.users_total ?? 0),
        usersToday: Number(row.users_today ?? 0),
        sessionsToday: Number(row.sessions_today ?? 0),
        reviewsToday: Number(row.reviews_today ?? 0),
      };
    },
  };
}

export type StatsRepo = ReturnType<typeof createStatsRepo>;

import {
  advance,
  buildQueue,
  currentItem,
  isFinished,
  type QueueItem,
  type QueueRepo,
  type QueueState,
  requeueCurrent,
} from "../core/queue.js";
import {
  type ApplyResult,
  type CardState,
  createScheduler,
  type Interval,
  type ReviewRating,
} from "../core/scheduler.js";
import { endOfLearningDay, recordActivity, startOfLearningDay } from "../core/streak.js";
import { type UndoRepo, undoLastReview } from "../core/undo.js";
import type { CardMode, Session, SessionStats, User } from "../db/schema.js";

/** Reviews per session before the rest is pushed to a "Продолжить" tap (SPEC §3.1). */
export const SESSION_REVIEW_CAP = 20;
/** More overdue cards than this and the session skips new cards entirely. */
export const SNOWBALL_THRESHOLD = 100;
/** Ratings below this interval are FSRS learning steps: the card comes back now. */
export const SHORT_INTERVAL_MS = 20 * 60_000;
/** "Снова" this many times and the card is called out as a leech. */
export const LEECH_THRESHOLD = 8;
/** An untouched session older than this is abandoned on the next /learn. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** Cards a "Ещё 5 новых" tap adds beyond today's allowance. */
export const EXTRA_NEW_BATCH = 5;
/** Length of the very first session (SPEC §1, step 6). */
export const FIRST_SESSION_SIZE = 5;

export interface SessionCardView {
  cardId: number;
  noteId: number;
  deckId: number;
  deckTitle: string;
  /** null for builtin decks — those can be reported but not edited or deleted. */
  deckOwnerId: number | null;
  mode: CardMode;
  front: string;
  back: string;
  transcription: string | null;
  example: string | null;
  exampleTr: string | null;
}

export interface SessionPort {
  queue: QueueRepo;
  undo: UndoRepo;
  findActiveSession(userId: number): Promise<Session | null>;
  findSession(id: number): Promise<Session | null>;
  createSession(input: {
    userId: number;
    deckId: number | null;
    chatId: number;
    queue: QueueItem[];
  }): Promise<Session>;
  saveSession(
    id: number,
    patch: Partial<Pick<Session, "queue" | "position" | "messageId" | "stats" | "messageSentAt">>,
  ): Promise<void>;
  finishSession(id: number, status: "finished" | "abandoned"): Promise<void>;
  cardView(cardId: number): Promise<SessionCardView | null>;
  cardState(cardId: number): Promise<CardState | null>;
  applyReview(cardId: number, userId: number, result: ApplyResult): Promise<void>;
  setSuspended(cardId: number, suspended: boolean): Promise<void>;
  setBuried(cardId: number, until: Date | null): Promise<void>;
  deleteNote(noteId: number): Promise<void>;
  reportNote(input: { noteId: number; userId: number; reason?: string | null }): Promise<void>;
  countDue(input: { userId: number; deckId: number | null; now: Date }): Promise<number>;
  nextDue(input: {
    userId: number;
    deckId: number | null;
    now: Date;
  }): Promise<{ at: Date; count: number } | null>;
  listLeeches(input: {
    userId: number;
    cardIds: number[];
    threshold: number;
  }): Promise<Array<{ cardId: number; lapses: number; front: string }>>;
  /** Sum of the per-deck new-card allowances (deck override or user default). */
  newLimitFor(user: User, deckId: number | null): Promise<number>;
  saveStreak(
    userId: number,
    update: { streak: number; lastDay: string | null; freezeDay: string | null },
  ): Promise<void>;
}

export type SessionStage = "question" | "answer" | "actions";

export interface SessionView {
  kind: "card";
  session: Session;
  stage: SessionStage;
  card: SessionCardView;
  isNew: boolean;
  /** 0-based queue index — this is what goes into callback data. */
  position: number;
  /** 1-based counter for "12 / 25". */
  index: number;
  total: number;
  previews: Record<ReviewRating, Interval> | null;
  canUndo: boolean;
  /** Set when new cards were held back because of the review backlog. */
  snowball: boolean;
}

export interface SessionSummary {
  kind: "summary";
  session: Session;
  stats: SessionStats;
  minutes: number;
  accuracy: number;
  streak: number;
  remainingDue: number;
  leech: { cardId: number; front: string } | null;
}

export interface EmptyQueue {
  kind: "empty";
  nextAt: Date | null;
  nextCount: number;
  snowball: boolean;
}

export type StartResult = SessionView | EmptyQueue;

export type RateResult =
  | { kind: "stale" }
  | { kind: "gone" }
  | ({ freezeUsed: boolean; streakExtended: boolean } & (SessionView | SessionSummary));

interface ServiceOptions {
  reviewCap?: number;
}

/** Pure: what the queue looks like after the current card was skipped. */
export function skipCurrent(state: QueueState): { state: QueueState; buried: boolean } {
  const current = currentItem(state);
  if (!current) return { state, buried: false };
  const skipped = current.skipped ?? 0;
  // Second skip means "отложить до завтра": drop it from the queue entirely.
  if (skipped >= 1) return { state: advance(state), buried: true };
  const items = state.items.slice();
  items.push({ ...current, skipped: skipped + 1 });
  return { state: { items, position: state.position + 1 }, buried: false };
}

/** Pure: undo puts the card back and removes the copy the re-queue inserted. */
export function rewindQueue(state: QueueState, cardId: number): QueueState {
  const position = Math.max(0, state.position - 1);
  const items = state.items.slice();
  const clone = items.findIndex((item, i) => i > position && item.cardId === cardId);
  if (clone >= 0) items.splice(clone, 1);
  return { items, position };
}

const STATS_KEYS = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
} as const satisfies Record<ReviewRating, keyof SessionStats>;

function statsKey(rating: ReviewRating): keyof SessionStats {
  return STATS_KEYS[rating];
}

export function accuracyOf(stats: SessionStats): number {
  return stats.reviewed > 0
    ? Math.round(((stats.reviewed - stats.again) / stats.reviewed) * 100)
    : 0;
}

export function createSessionService(port: SessionPort, options: ServiceOptions = {}) {
  const reviewCap = options.reviewCap ?? SESSION_REVIEW_CAP;

  async function viewAt(
    session: Session,
    user: User,
    now: Date,
    stage: SessionStage,
    extras: { snowball?: boolean; canUndo?: boolean } = {},
  ): Promise<SessionView | null> {
    const item = session.queue[session.position];
    if (!item) return null;
    const card = await port.cardView(item.cardId);
    if (!card) return null;
    let previews: Record<ReviewRating, Interval> | null = null;
    if (stage === "answer" && user.showIntervals) {
      const state = await port.cardState(item.cardId);
      if (state) {
        const scheduler = createScheduler(user.desiredRetention);
        const preview = scheduler.previewIntervals(state, now);
        previews = {
          1: preview[1].interval,
          2: preview[2].interval,
          3: preview[3].interval,
          4: preview[4].interval,
        };
      }
    }
    return {
      kind: "card",
      session,
      stage,
      card,
      isNew: item.isNew,
      position: session.position,
      index: session.position + 1,
      total: session.queue.length,
      previews,
      canUndo: extras.canUndo ?? session.stats.reviewed > 0,
      snowball: extras.snowball ?? false,
    };
  }

  /** The schema allows one active session per user, so make room before creating one. */
  async function closeActive(userId: number): Promise<void> {
    const active = await port.findActiveSession(userId);
    if (active) await port.finishSession(active.id, "finished");
  }

  async function summarize(session: Session, now: Date, streak: number): Promise<SessionSummary> {
    const cardIds = [...new Set(session.queue.map((item) => item.cardId))];
    const [leeches, remainingDue] = await Promise.all([
      port.listLeeches({ userId: session.userId, cardIds, threshold: LEECH_THRESHOLD }),
      port.countDue({ userId: session.userId, deckId: session.deckId, now }),
    ]);
    const leech = leeches[0];
    return {
      kind: "summary",
      session,
      stats: session.stats,
      minutes: Math.max(1, Math.round((now.getTime() - session.startedAt.getTime()) / 60_000)),
      accuracy: accuracyOf(session.stats),
      streak,
      remainingDue,
      leech: leech ? { cardId: leech.cardId, front: leech.front } : null,
    };
  }

  return {
    /** Active session, or null after abandoning one that went stale. */
    async current(user: User, now: Date): Promise<Session | null> {
      const session = await port.findActiveSession(user.id);
      if (!session) return null;
      if (now.getTime() - session.startedAt.getTime() > SESSION_IDLE_MS) {
        await port.finishSession(session.id, "abandoned");
        return null;
      }
      return session;
    },

    /**
     * Builds a queue and opens a session. `extraNew` bypasses today's allowance
     * ("Ещё 5 новых"); `newLimit` overrides it outright (first session).
     */
    async start(input: {
      user: User;
      deckId: number | null;
      chatId: number;
      now: Date;
      newLimit?: number;
      extraNew?: number;
    }): Promise<StartResult> {
      const { user, deckId, now } = input;
      // Only one active session per user is allowed by the schema; opening a
      // new one supersedes whatever was still open.
      await closeActive(user.id);
      const dayStart = startOfLearningDay(now, user.tz);
      const overdue = await port.countDue({ userId: user.id, deckId, now });
      const snowball = overdue > SNOWBALL_THRESHOLD;

      let dailyNewLimit = input.newLimit ?? (await port.newLimitFor(user, deckId));
      if (snowball && input.extraNew === undefined) dailyNewLimit = 0;

      const built = await buildQueue(port.queue, {
        userId: user.id,
        deckId,
        now,
        dayStart,
        dailyNewLimit,
        maxReviews: reviewCap,
      });

      if (input.extraNew !== undefined && input.extraNew > 0) {
        // "Ещё 5 новых" — a one-off overrun of today's allowance. `dayStart: now`
        // makes the builder ignore what was already introduced today, and the
        // limit stays at `extraNew` so it materializes exactly that many cards.
        const extra = await buildQueue(port.queue, {
          userId: user.id,
          deckId,
          now,
          dayStart: now,
          dailyNewLimit: input.extraNew,
          maxReviews: 0,
        });
        const seen = new Set(built.items.map((item) => item.cardId));
        for (const item of extra.items) {
          if (seen.has(item.cardId)) continue;
          built.items.push(item);
          seen.add(item.cardId);
        }
      }

      if (built.items.length === 0) {
        const next = await port.nextDue({ userId: user.id, deckId, now });
        return {
          kind: "empty",
          nextAt: next?.at ?? null,
          nextCount: next?.count ?? 0,
          snowball,
        };
      }

      const session = await port.createSession({
        userId: user.id,
        deckId,
        chatId: input.chatId,
        queue: built.items,
      });
      const view = await viewAt(session, user, now, "question", { snowball, canUndo: false });
      return view ?? { kind: "empty", nextAt: null, nextCount: 0, snowball };
    },

    /** Re-renders the session at its stored position (source of truth is the DB). */
    async render(
      session: Session,
      user: User,
      now: Date,
      stage: SessionStage = "question",
    ): Promise<SessionView | null> {
      return viewAt(session, user, now, stage);
    },

    /** Records a rating. `position` comes from the button and guards double taps. */
    async rate(input: {
      user: User;
      session: Session;
      position: number;
      rating: ReviewRating;
      now: Date;
    }): Promise<RateResult> {
      const { user, session, position, rating, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const state = await port.cardState(item.cardId);
      if (!state) return { kind: "gone" };

      const scheduler = createScheduler(user.desiredRetention);
      const result = scheduler.applyRating(state, rating, now);
      await port.applyReview(item.cardId, user.id, result);

      const stats: SessionStats = {
        ...session.stats,
        reviewed: session.stats.reviewed + 1,
        newLearned: session.stats.newLearned + (item.isNew ? 1 : 0),
      };
      stats[statsKey(rating)] += 1;

      const short = result.card.due.getTime() - now.getTime() < SHORT_INTERVAL_MS;
      const next = short
        ? requeueCurrent({ items: session.queue, position })
        : advance({ items: session.queue, position });

      await port.saveSession(session.id, {
        queue: next.items,
        position: next.position,
        stats,
      });

      const streakBefore = {
        streak: user.streak,
        lastDay: user.streakLastDay,
        freezeDay: user.streakFreezeDay,
      };
      const streak = recordActivity(streakBefore, now, user.tz);
      if (streak.lastDay !== streakBefore.lastDay || streak.streak !== streakBefore.streak) {
        await port.saveStreak(user.id, streak);
      }

      const updated: Session = {
        ...session,
        queue: next.items,
        position: next.position,
        stats,
      };
      const meta = { freezeUsed: streak.freezeUsed, streakExtended: streak.extended };

      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return { ...(await summarize(updated, now, streak.streak)), ...meta };
      }
      const view = await viewAt({ ...updated, stats }, user, now, "question");
      if (!view) {
        await port.finishSession(session.id, "finished");
        return { ...(await summarize(updated, now, streak.streak)), ...meta };
      }
      return { ...view, ...meta };
    },

    /** Pushes the card to the end of the queue; the second skip buries it. */
    async skip(input: {
      user: User;
      session: Session;
      position: number;
      now: Date;
    }): Promise<{ view: SessionView | SessionSummary; buried: boolean } | { kind: "stale" }> {
      const { user, session, position, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const { state: next, buried } = skipCurrent({ items: session.queue, position });
      if (buried) await port.setBuried(item.cardId, endOfLearningDay(now, user.tz));
      await port.saveSession(session.id, { queue: next.items, position: next.position });
      const updated: Session = { ...session, queue: next.items, position: next.position };
      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return { view: await summarize(updated, now, user.streak), buried };
      }
      const view = await viewAt(updated, user, now, "question");
      if (!view) {
        await port.finishSession(session.id, "finished");
        return { view: await summarize(updated, now, user.streak), buried };
      }
      return { view, buried };
    },

    async finish(input: { user: User; session: Session; now: Date }): Promise<SessionSummary> {
      await port.finishSession(input.session.id, "finished");
      return summarize(input.session, input.now, input.user.streak);
    },

    /**
     * Rolls the last rating back (depth 1) and makes that card current again.
     * Only ratings that belong to this session can be undone.
     */
    async undo(input: {
      user: User;
      session: Session;
      now: Date;
    }): Promise<SessionView | { kind: "nothing" }> {
      const { user, session, now } = input;
      if (session.stats.reviewed === 0) return { kind: "nothing" };
      const result = await undoLastReview(port.undo, user.id);
      if (!result) return { kind: "nothing" };

      const next = rewindQueue({ items: session.queue, position: session.position }, result.cardId);
      const item = next.items[next.position];
      const stats: SessionStats = { ...session.stats };
      stats.reviewed = Math.max(0, stats.reviewed - 1);
      const key = statsKey(result.rating as ReviewRating);
      stats[key] = Math.max(0, stats[key] - 1);
      if (result.wasNew) stats.newLearned = Math.max(0, stats.newLearned - 1);
      if (item) item.isNew = result.wasNew;

      await port.saveSession(session.id, {
        queue: next.items,
        position: next.position,
        stats,
      });
      const updated: Session = {
        ...session,
        queue: next.items,
        position: next.position,
        stats,
      };
      const view = await viewAt(updated, user, now, "question", { canUndo: false });
      return view ?? { kind: "nothing" };
    },

    /** Card-actions menu: suspend / bury / report / delete, then move on. */
    async cardAction(input: {
      user: User;
      session: Session;
      position: number;
      action: "suspend" | "bury" | "report" | "delete";
      now: Date;
    }): Promise<SessionView | SessionSummary | { kind: "stale" }> {
      const { user, session, position, action, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const card = await port.cardView(item.cardId);
      if (!card) return { kind: "stale" };

      if (action === "suspend") await port.setSuspended(item.cardId, true);
      if (action === "bury") await port.setBuried(item.cardId, endOfLearningDay(now, user.tz));
      if (action === "report") {
        await port.reportNote({ noteId: card.noteId, userId: user.id });
      }
      if (action === "delete") await port.deleteNote(card.noteId);

      if (action === "report") {
        const view = await viewAt(session, user, now, "question");
        return view ?? (await summarize(session, now, user.streak));
      }

      // The card leaves the session: drop every occurrence of it from the queue.
      const items = session.queue.filter(
        (queued, i) => queued.cardId !== item.cardId || i < position,
      );
      const next: QueueState = { items, position };
      await port.saveSession(session.id, { queue: items, position });
      const updated: Session = { ...session, queue: items, position };
      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return summarize(updated, now, user.streak);
      }
      const view = await viewAt(updated, user, now, "question");
      return view ?? (await summarize(updated, now, user.streak));
    },

    /**
     * Opens a session over an explicit list of cards — used by "Учить сейчас",
     * which pulls one card in outside the daily new-card allowance (SPEC §4.1).
     */
    async startWith(input: {
      user: User;
      chatId: number;
      deckId: number | null;
      cardIds: number[];
      now: Date;
    }): Promise<SessionView | null> {
      await closeActive(input.user.id);
      const items: QueueItem[] = [];
      for (const cardId of input.cardIds) {
        const state = await port.cardState(cardId);
        if (!state) continue;
        items.push({ cardId, isNew: state.state === 0 });
      }
      if (items.length === 0) return null;
      const session = await port.createSession({
        userId: input.user.id,
        deckId: input.deckId,
        chatId: input.chatId,
        queue: items,
      });
      return viewAt(session, input.user, input.now, "question", { canUndo: false });
    },

    /** Suspends a leech straight from the post-session notice. */
    async suspendCard(cardId: number): Promise<void> {
      await port.setSuspended(cardId, true);
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

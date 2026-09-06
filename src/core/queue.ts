import type { CardMode, QueueItem } from "../db/schema.js";

export type { QueueItem };

/** How many times one card may come back within a single session. */
export const MAX_REQUEUES = 3;
export const DEFAULT_MAX_REVIEWS = 20;

export interface DueCard {
  cardId: number;
  due: Date;
}

/**
 * A note the user has not started yet in this mode: either no `cards` row
 * exists, or one exists but is still in the New state (a session that was
 * abandoned before the card got its first rating).
 */
export interface NewCandidate {
  noteId: number;
  deckId: number;
  mode: CardMode;
  position: number;
  cardId: number | null;
}

/** Data access the queue builder needs; implemented by `db/repos/cards.ts`. */
export interface QueueRepo {
  /** Cards past their due date, not suspended, not New, ordered by due asc. */
  listDueCards(input: {
    userId: number;
    deckId: number | null;
    now: Date;
    limit: number;
  }): Promise<DueCard[]>;
  /** Not-yet-started notes for this user/mode, in deck → position order. */
  listNewCandidates(input: {
    userId: number;
    deckId: number | null;
    limit: number;
  }): Promise<NewCandidate[]>;
  /** New cards already introduced since the start of the user's learning day. */
  countNewIntroducedSince(input: { userId: number; since: Date }): Promise<number>;
  /** Creates the lazily-materialized card row and returns its id. */
  createCard(input: { userId: number; noteId: number; mode: CardMode; due: Date }): Promise<number>;
}

export interface BuildQueueOptions {
  userId: number;
  /** null = every subscribed deck. */
  deckId: number | null;
  now: Date;
  /** Start of the user's learning day (04:00 local), see `core/streak.ts`. */
  dayStart: Date;
  /** Effective new-cards-per-day limit (deck override or user default). */
  dailyNewLimit: number;
  maxReviews?: number;
}

export interface BuiltQueue {
  items: QueueItem[];
  dueCount: number;
  newCount: number;
}

/**
 * Session queue: overdue reviews first (by due date), then new cards in deck
 * order, capped by what is left of today's new-card allowance. Cards for new
 * notes are created here — that is the only place they are materialized.
 */
export async function buildQueue(repo: QueueRepo, options: BuildQueueOptions): Promise<BuiltQueue> {
  const { userId, deckId, now, dayStart, dailyNewLimit } = options;
  const maxReviews = options.maxReviews ?? DEFAULT_MAX_REVIEWS;

  const due = await repo.listDueCards({ userId, deckId, now, limit: maxReviews });
  const items: QueueItem[] = due.map((card) => ({ cardId: card.cardId, isNew: false }));

  const introduced = await repo.countNewIntroducedSince({ userId, since: dayStart });
  const allowance = Math.max(0, dailyNewLimit - introduced);

  let newCount = 0;
  if (allowance > 0) {
    const candidates = await repo.listNewCandidates({ userId, deckId, limit: allowance });
    for (const candidate of candidates) {
      const cardId =
        candidate.cardId ??
        (await repo.createCard({
          userId,
          noteId: candidate.noteId,
          mode: candidate.mode,
          due: now,
        }));
      items.push({ cardId, isNew: true });
      newCount += 1;
    }
  }

  return { items, dueCount: due.length, newCount };
}

export interface QueueState {
  items: QueueItem[];
  position: number;
}

export function currentItem(state: QueueState): QueueItem | null {
  return state.items[state.position] ?? null;
}

export function isFinished(state: QueueState): boolean {
  return state.position >= state.items.length;
}

export function remaining(state: QueueState): number {
  return Math.max(0, state.items.length - state.position);
}

/** Moves to the next card without re-queuing the current one. */
export function advance(state: QueueState): QueueState {
  return { items: state.items, position: Math.min(state.position + 1, state.items.length) };
}

/**
 * Puts the current card back at the end of the session, due for its next
 * learning step at `notBefore`, and moves on. Used when a rating yields a
 * short (learning-step) interval. A card comes back at most `MAX_REQUEUES`
 * times per session; after that it waits for the next session.
 *
 * `intro` marks the return that «знакомство» schedules (SPEC §3.2): no rating
 * was given, so the copy stays new, is marked as introduced and does not spend
 * one of the card's `MAX_REQUEUES` returns.
 */
export function requeueCurrent(
  state: QueueState,
  notBefore: number,
  options: { intro?: boolean } = {},
): QueueState {
  const current = currentItem(state);
  if (!current) return state;
  const items = state.items.slice();
  if (options.intro) {
    items.push({ ...current, notBefore, introduced: true });
    return { items, position: state.position + 1 };
  }
  const requeues = (current.requeues ?? 0) + 1;
  // The card is no longer new once it has been answered once.
  if (requeues <= MAX_REQUEUES)
    items.push({ cardId: current.cardId, isNew: false, notBefore, requeues });
  return { items, position: state.position + 1 };
}

/**
 * Makes sure the card at `position` may be shown now. A re-queued learning
 * card waits until its step is due; if another card is eligible it is pulled
 * forward instead. When nothing else is left the learning card is shown early
 * (Anki's "learn ahead").
 */
export function settle(state: QueueState, now: Date): QueueState {
  const current = currentItem(state);
  if (!current || (current.notBefore ?? 0) <= now.getTime()) return state;
  const next = state.items.findIndex(
    (item, i) => i > state.position && (item.notBefore ?? 0) <= now.getTime(),
  );
  if (next < 0) return state;
  const items = state.items.slice();
  const [picked] = items.splice(next, 1);
  items.splice(state.position, 0, picked as QueueItem);
  return { items, position: state.position };
}

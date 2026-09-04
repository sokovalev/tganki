import type { CardMode, QueueItem } from "../db/schema.js";

export type { QueueItem };

/** How many unanswered cards to keep in front of a re-queued learning card. */
export const DEFAULT_REQUEUE_GAP = 3;
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
 * Puts the current card back into the session `gap` cards later (or at the end
 * when fewer than `gap` cards are left) and moves on. Used when a card is rated
 * Again/Hard and is still in a learning state.
 */
export function requeueCurrent(state: QueueState, gap = DEFAULT_REQUEUE_GAP): QueueState {
  const current = currentItem(state);
  if (!current) return state;
  const items = state.items.slice();
  const insertAt = Math.min(state.position + 1 + gap, items.length);
  // The card is no longer new once it has been answered once.
  items.splice(insertAt, 0, { cardId: current.cardId, isNew: false });
  return { items, position: state.position + 1 };
}

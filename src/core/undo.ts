import type { CardState } from "./scheduler.js";

/** The subset of a `review_logs` row needed to revert a review. */
export interface ReviewLogSnapshot {
  id: number;
  cardId: number;
  userId: number;
  rating: number;
  reviewedAt: Date;
  stateBefore: number;
  stabilityBefore: number;
  difficultyBefore: number;
  dueBefore: Date;
  lastReviewBefore: Date | null;
  repsBefore: number;
  lapsesBefore: number;
  learningStepsBefore: number;
  elapsedDaysBefore: number;
  elapsedDays: number;
  scheduledDays: number;
}

export interface UndoRepo {
  /** Most recent review of this user, or null. */
  findLastReview(userId: number): Promise<ReviewLogSnapshot | null>;
  /** Restores the card and deletes the log row in one transaction. */
  revert(log: ReviewLogSnapshot, card: CardState): Promise<void>;
}

export interface UndoResult {
  logId: number;
  cardId: number;
  rating: number;
  /** The card was seen for the first time, so undo makes it new again. */
  wasNew: boolean;
  card: CardState;
}

/** Card state exactly as it was before the logged review. */
export function revertCard(log: ReviewLogSnapshot): CardState {
  return {
    state: log.stateBefore,
    stability: log.stabilityBefore,
    difficulty: log.difficultyBefore,
    due: log.dueBefore,
    lastReview: log.lastReviewBefore,
    reps: log.repsBefore,
    lapses: log.lapsesBefore,
    elapsedDays: log.elapsedDaysBefore,
    scheduledDays: log.scheduledDays,
    learningSteps: log.learningStepsBefore,
  };
}

/** Reverts the user's last review. Returns null when there is nothing to undo. */
export async function undoLastReview(repo: UndoRepo, userId: number): Promise<UndoResult | null> {
  const log = await repo.findLastReview(userId);
  if (!log) return null;
  const card = revertCard(log);
  await repo.revert(log, card);
  return {
    logId: log.id,
    cardId: log.cardId,
    rating: log.rating,
    wasNew: log.stateBefore === 0,
    card,
  };
}

import { desc, eq } from "drizzle-orm";
import type { CardState } from "../../core/scheduler.js";
import type { ReviewLogSnapshot, UndoRepo } from "../../core/undo.js";
import type { Database } from "../index.js";
import { cards, reviewLogs } from "../schema.js";

export function createReviewLogsRepo(db: Database) {
  const repo = {
    async findLastReview(userId: number): Promise<ReviewLogSnapshot | null> {
      const [row] = await db
        .select()
        .from(reviewLogs)
        .where(eq(reviewLogs.userId, userId))
        .orderBy(desc(reviewLogs.reviewedAt), desc(reviewLogs.id))
        .limit(1);
      return row ?? null;
    },

    /** Restores the card snapshot and drops the log row in one transaction. */
    async revert(log: ReviewLogSnapshot, card: CardState): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(cards)
          .set({
            state: card.state,
            stability: card.stability,
            difficulty: card.difficulty,
            due: card.due,
            lastReview: card.lastReview,
            reps: card.reps,
            lapses: card.lapses,
            elapsedDays: card.elapsedDays,
            scheduledDays: card.scheduledDays,
            learningSteps: card.learningSteps,
          })
          .where(eq(cards.id, log.cardId));
        await tx.delete(reviewLogs).where(eq(reviewLogs.id, log.id));
      });
    },
  };

  return repo satisfies UndoRepo;
}

export type ReviewLogsRepo = ReturnType<typeof createReviewLogsRepo>;

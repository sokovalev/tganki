import { describe, expect, it } from "vitest";
import { createScheduler } from "../src/core/scheduler.js";
import {
  type ReviewLogSnapshot,
  revertCard,
  type UndoRepo,
  undoLastReview,
} from "../src/core/undo.js";

const NOW = new Date("2026-01-01T10:00:00.000Z");
const scheduler = createScheduler();

function fakeRepo(logs: ReviewLogSnapshot[]) {
  const reverted: Array<{ logId: number; cardId: number }> = [];
  const repo: UndoRepo = {
    async findLastReview() {
      return logs.at(-1) ?? null;
    },
    async revert(log) {
      reverted.push({ logId: log.id, cardId: log.cardId });
      logs.pop();
    },
  };
  return { repo, reverted };
}

function toRow(
  log: ReturnType<typeof scheduler.applyRating>["log"],
  ids: { id: number; cardId: number; userId: number },
): ReviewLogSnapshot {
  return { ...ids, ...log };
}

describe("revertCard", () => {
  it("restores the exact card state of a reviewed card", () => {
    const before = scheduler.applyRating(scheduler.newCard(NOW), 4, NOW).card;
    const later = new Date(NOW.getTime() + 12 * 86_400_000);
    const { log } = scheduler.applyRating(before, 1, later);

    expect(revertCard(toRow(log, { id: 1, cardId: 7, userId: 3 }))).toEqual(before);
  });

  it("restores a never-reviewed card to the New state", () => {
    const before = scheduler.newCard(NOW);
    const { log } = scheduler.applyRating(before, 3, NOW);

    const restored = revertCard(toRow(log, { id: 1, cardId: 7, userId: 3 }));
    expect(restored).toEqual(before);
    expect(restored.state).toBe(0);
    expect(restored.lastReview).toBeNull();
  });
});

describe("undoLastReview", () => {
  it("returns null when the user has no reviews", async () => {
    const { repo } = fakeRepo([]);
    expect(await undoLastReview(repo, 3)).toBeNull();
  });

  it("reverts the most recent review and reports whether the card was new", async () => {
    const card = scheduler.newCard(NOW);
    const first = scheduler.applyRating(card, 3, NOW);
    const second = scheduler.applyRating(first.card, 1, new Date(NOW.getTime() + 600_000));
    const logs = [
      toRow(first.log, { id: 1, cardId: 7, userId: 3 }),
      toRow(second.log, { id: 2, cardId: 7, userId: 3 }),
    ];
    const { repo, reverted } = fakeRepo(logs);

    const undone = await undoLastReview(repo, 3);
    expect(undone).toMatchObject({ logId: 2, cardId: 7, rating: 1, wasNew: false });
    expect(undone?.card).toEqual(first.card);
    expect(reverted).toEqual([{ logId: 2, cardId: 7 }]);

    const again = await undoLastReview(repo, 3);
    expect(again).toMatchObject({ logId: 1, wasNew: true });
    expect(again?.card).toEqual(card);
  });
});

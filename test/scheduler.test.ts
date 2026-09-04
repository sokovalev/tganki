import { describe, expect, it } from "vitest";
import {
  createScheduler,
  describeInterval,
  fromFsrsCard,
  isLearning,
  toFsrsCard,
} from "../src/core/scheduler.js";

const NOW = new Date("2026-01-01T10:00:00.000Z");
const scheduler = createScheduler();

describe("describeInterval", () => {
  it("never goes below one minute", () => {
    expect(describeInterval(30_000)).toEqual({ unit: "minute", value: 1 });
    expect(describeInterval(0)).toEqual({ unit: "minute", value: 1 });
  });

  it("picks the largest fitting unit", () => {
    expect(describeInterval(6 * 60_000)).toEqual({ unit: "minute", value: 6 });
    expect(describeInterval(90 * 60_000)).toEqual({ unit: "hour", value: 2 });
    expect(describeInterval(3 * 86_400_000)).toEqual({ unit: "day", value: 3 });
    expect(describeInterval(45 * 86_400_000)).toEqual({ unit: "month", value: 1.5 });
    expect(describeInterval(400 * 86_400_000)).toEqual({ unit: "year", value: 1.1 });
  });
});

describe("card mapping", () => {
  it("round-trips through the ts-fsrs shape", () => {
    const card = {
      state: 2,
      stability: 12.5,
      difficulty: 5.5,
      due: new Date("2026-02-01T00:00:00.000Z"),
      lastReview: new Date("2026-01-20T00:00:00.000Z"),
      reps: 4,
      lapses: 1,
      elapsedDays: 12,
      scheduledDays: 12,
      learningSteps: 0,
    };
    expect(fromFsrsCard(toFsrsCard(card))).toEqual(card);
  });

  it("treats learning and relearning as in-session states", () => {
    expect(isLearning({ state: 0 })).toBe(false);
    expect(isLearning({ state: 1 })).toBe(true);
    expect(isLearning({ state: 2 })).toBe(false);
    expect(isLearning({ state: 3 })).toBe(true);
  });
});

describe("previewIntervals", () => {
  it("uses the 1m/10m learning steps for a brand new card", () => {
    const preview = scheduler.previewIntervals(scheduler.newCard(NOW), NOW);
    expect(preview[1].interval).toEqual({ unit: "minute", value: 1 });
    expect(preview[3].interval).toEqual({ unit: "minute", value: 10 });
    expect(preview[4].interval.unit).toBe("day");
  });

  it("orders the four ratings by increasing due date", () => {
    const preview = scheduler.previewIntervals(scheduler.newCard(NOW), NOW);
    const dues = [1, 2, 3, 4].map((r) => preview[r as 1 | 2 | 3 | 4].due.getTime());
    expect(dues).toEqual([...dues].sort((a, b) => a - b));
  });

  it("agrees with what applyRating actually schedules", () => {
    const card = scheduler.newCard(NOW);
    const preview = scheduler.previewIntervals(card, NOW);
    for (const rating of [1, 2, 3, 4] as const) {
      const applied = scheduler.applyRating(card, rating, NOW);
      expect(applied.card.due).toEqual(preview[rating].due);
    }
  });
});

describe("applyRating", () => {
  it("moves a new card into learning and logs the previous state", () => {
    const card = scheduler.newCard(NOW);
    const { card: next, log } = scheduler.applyRating(card, 3, NOW);

    expect(next.state).toBe(1);
    expect(next.reps).toBe(1);
    expect(next.lastReview).toEqual(NOW);
    expect(next.stability).toBeGreaterThan(0);
    expect(log).toMatchObject({
      rating: 3,
      reviewedAt: NOW,
      stateBefore: 0,
      dueBefore: card.due,
      lastReviewBefore: null,
      repsBefore: 0,
      lapsesBefore: 0,
    });
  });

  it("graduates to review and counts a lapse on Again", () => {
    const card = scheduler.newCard(NOW);
    const graduated = scheduler.applyRating(card, 4, NOW).card;
    expect(graduated.state).toBe(2);
    expect(graduated.scheduledDays).toBeGreaterThan(0);

    const later = new Date(graduated.due.getTime());
    const lapsed = scheduler.applyRating(graduated, 1, later).card;
    expect(lapsed.state).toBe(3);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(2);
  });

  it("records the real gap between reviews for the optimizer", () => {
    const card = scheduler.newCard(NOW);
    const graduated = scheduler.applyRating(card, 4, NOW).card;
    const later = new Date(NOW.getTime() + 10 * 86_400_000);
    const { log } = scheduler.applyRating(graduated, 3, later);

    expect(log.elapsedDays).toBe(10);
    expect(log.scheduledDays).toBe(graduated.scheduledDays);
    expect(log.elapsedDaysBefore).toBe(graduated.elapsedDays);
  });

  it("honours a lower desired retention with longer intervals", () => {
    const relaxed = createScheduler(0.8);
    const strict = createScheduler(0.95);
    const card = scheduler.newCard(NOW);
    const relaxedDue = relaxed.applyRating(card, 4, NOW).card.due.getTime();
    const strictDue = strict.applyRating(card, 4, NOW).card.due.getTime();
    expect(relaxedDue).toBeGreaterThan(strictDue);
  });
});

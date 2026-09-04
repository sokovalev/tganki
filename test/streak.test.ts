import { describe, expect, it } from "vitest";
import {
  daysBetween,
  endOfLearningDay,
  learningDayKey,
  recordActivity,
  type StreakState,
  startOfLearningDay,
  updateStreak,
} from "../src/core/streak.js";

describe("learning day boundary", () => {
  it("counts a 02:30 local session as the previous day", () => {
    const night = new Date("2026-01-10T23:30:00.000Z"); // 02:30 MSK on Jan 11
    expect(learningDayKey(night, "Europe/Moscow")).toBe("2026-01-10");
    expect(startOfLearningDay(night, "Europe/Moscow").toISOString()).toBe(
      "2026-01-10T01:00:00.000Z", // 04:00 MSK
    );
  });

  it("starts the new day at 04:00 local", () => {
    const early = new Date("2026-01-11T01:00:00.000Z"); // 04:00 MSK on Jan 11
    expect(learningDayKey(early, "Europe/Moscow")).toBe("2026-01-11");
    const justBefore = new Date("2026-01-11T00:59:59.000Z");
    expect(learningDayKey(justBefore, "Europe/Moscow")).toBe("2026-01-10");
  });

  it("works in UTC", () => {
    expect(learningDayKey(new Date("2026-01-10T03:59:00.000Z"), "UTC")).toBe("2026-01-09");
    expect(learningDayKey(new Date("2026-01-10T04:00:00.000Z"), "UTC")).toBe("2026-01-10");
  });

  it("handles a DST transition", () => {
    // 2026-03-08 is the US spring-forward date.
    const beforeSwitch = new Date("2026-03-08T05:00:00.000Z"); // 00:00 EST
    expect(learningDayKey(beforeSwitch, "America/New_York")).toBe("2026-03-07");
    const afterSwitch = new Date("2026-03-08T09:00:00.000Z"); // 05:00 EDT
    expect(learningDayKey(afterSwitch, "America/New_York")).toBe("2026-03-08");
  });

  it("ends the day exactly 24 hours after it started", () => {
    const now = new Date("2026-01-10T12:00:00.000Z");
    expect(endOfLearningDay(now, "Europe/Moscow").getTime()).toBe(
      startOfLearningDay(now, "Europe/Moscow").getTime() + 86_400_000,
    );
  });

  it("falls back to UTC for an unknown timezone", () => {
    const now = new Date("2026-01-10T03:00:00.000Z");
    expect(learningDayKey(now, "Mars/Olympus")).toBe(learningDayKey(now, "UTC"));
  });

  it("counts whole days between keys", () => {
    expect(daysBetween("2026-01-09", "2026-01-10")).toBe(1);
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(daysBetween("2026-01-10", "2026-01-10")).toBe(0);
  });
});

describe("updateStreak", () => {
  const fresh: StreakState = { streak: 0, lastDay: null, freezeDay: null };

  it("starts at one", () => {
    expect(updateStreak(fresh, "2026-01-10")).toMatchObject({
      streak: 1,
      lastDay: "2026-01-10",
      extended: true,
    });
  });

  it("does not change on a second session the same day", () => {
    const state: StreakState = { streak: 5, lastDay: "2026-01-10", freezeDay: null };
    expect(updateStreak(state, "2026-01-10")).toMatchObject({ streak: 5, extended: false });
  });

  it("increments on consecutive days", () => {
    const state: StreakState = { streak: 5, lastDay: "2026-01-10", freezeDay: null };
    expect(updateStreak(state, "2026-01-11")).toMatchObject({ streak: 6, extended: true });
  });

  it("spends the weekly freeze on a single missed day", () => {
    const state: StreakState = { streak: 5, lastDay: "2026-01-10", freezeDay: null };
    const next = updateStreak(state, "2026-01-12");
    expect(next).toMatchObject({
      streak: 6,
      lastDay: "2026-01-12",
      freezeDay: "2026-01-12",
      freezeUsed: true,
      reset: false,
    });
  });

  it("resets when the freeze was already used this week", () => {
    const state: StreakState = { streak: 6, lastDay: "2026-01-12", freezeDay: "2026-01-12" };
    expect(updateStreak(state, "2026-01-14")).toMatchObject({
      streak: 1,
      reset: true,
      freezeUsed: false,
    });
  });

  it("gives the freeze back after seven days", () => {
    const state: StreakState = { streak: 6, lastDay: "2026-01-18", freezeDay: "2026-01-12" };
    expect(updateStreak(state, "2026-01-20")).toMatchObject({ streak: 7, freezeUsed: true });
  });

  it("resets after two or more missed days", () => {
    const state: StreakState = { streak: 9, lastDay: "2026-01-10", freezeDay: null };
    expect(updateStreak(state, "2026-01-13")).toMatchObject({ streak: 1, reset: true });
  });

  it("derives the day from the timestamp and timezone", () => {
    const state: StreakState = { streak: 2, lastDay: "2026-01-09", freezeDay: null };
    const night = new Date("2026-01-10T23:30:00.000Z"); // still Jan 10 in Moscow
    expect(recordActivity(state, night, "Europe/Moscow")).toMatchObject({
      streak: 3,
      lastDay: "2026-01-10",
    });
  });
});

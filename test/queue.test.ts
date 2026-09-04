import { beforeEach, describe, expect, it } from "vitest";
import {
  advance,
  buildQueue,
  currentItem,
  isFinished,
  type NewCandidate,
  type QueueRepo,
  remaining,
  requeueCurrent,
} from "../src/core/queue.js";
import type { CardMode } from "../src/db/schema.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const DAY_START = new Date("2026-01-10T04:00:00.000Z");

interface FakeState {
  due: Array<{ cardId: number; due: Date }>;
  candidates: NewCandidate[];
  introduced: number;
  created: Array<{ userId: number; noteId: number; mode: CardMode; due: Date }>;
  nextCardId: number;
}

function fakeRepo(state: FakeState): QueueRepo {
  return {
    async listDueCards({ limit }) {
      return [...state.due].sort((a, b) => a.due.getTime() - b.due.getTime()).slice(0, limit);
    },
    async listNewCandidates({ limit }) {
      return state.candidates.slice(0, limit);
    },
    async countNewIntroducedSince() {
      return state.introduced;
    },
    async createCard(input) {
      state.created.push(input);
      return state.nextCardId++;
    },
  };
}

function candidate(noteId: number, position: number, cardId: number | null = null): NewCandidate {
  return { noteId, deckId: 1, mode: "recognition", position, cardId };
}

describe("buildQueue", () => {
  let state: FakeState;

  beforeEach(() => {
    state = { due: [], candidates: [], introduced: 0, created: [], nextCardId: 100 };
  });

  const build = (dailyNewLimit: number, maxReviews?: number) =>
    buildQueue(fakeRepo(state), {
      userId: 1,
      deckId: null,
      now: NOW,
      dayStart: DAY_START,
      dailyNewLimit,
      ...(maxReviews === undefined ? {} : { maxReviews }),
    });

  it("puts due reviews first, ordered by due date, then new cards", async () => {
    state.due = [
      { cardId: 2, due: new Date("2026-01-10T09:00:00.000Z") },
      { cardId: 1, due: new Date("2026-01-09T09:00:00.000Z") },
    ];
    state.candidates = [candidate(10, 0), candidate(11, 1)];

    const result = await build(5);

    expect(result.items).toEqual([
      { cardId: 1, isNew: false },
      { cardId: 2, isNew: false },
      { cardId: 100, isNew: true },
      { cardId: 101, isNew: true },
    ]);
    expect(result.dueCount).toBe(2);
    expect(result.newCount).toBe(2);
  });

  it("caps reviews at maxReviews", async () => {
    state.due = Array.from({ length: 30 }, (_, i) => ({
      cardId: i + 1,
      due: new Date(NOW.getTime() - i * 1000),
    }));
    const result = await build(0, 20);
    expect(result.items).toHaveLength(20);
  });

  it("subtracts the new cards already introduced today", async () => {
    state.introduced = 8;
    state.candidates = [candidate(1, 0), candidate(2, 1), candidate(3, 2)];
    const result = await build(10);
    expect(result.newCount).toBe(2);
    expect(state.created).toHaveLength(2);
  });

  it("introduces nothing once the daily limit is used up", async () => {
    state.introduced = 10;
    state.candidates = [candidate(1, 0)];
    const result = await build(10);
    expect(result.newCount).toBe(0);
    expect(state.created).toEqual([]);
  });

  it("creates card rows lazily, in note position order", async () => {
    state.candidates = [candidate(7, 0), candidate(8, 1)];
    await build(5);
    expect(state.created).toEqual([
      { userId: 1, noteId: 7, mode: "recognition", due: NOW },
      { userId: 1, noteId: 8, mode: "recognition", due: NOW },
    ]);
  });

  it("reuses a card that was materialized but never rated", async () => {
    state.candidates = [candidate(7, 0, 55), candidate(8, 1)];
    const result = await build(5);
    expect(result.items).toEqual([
      { cardId: 55, isNew: true },
      { cardId: 100, isNew: true },
    ]);
    expect(state.created).toHaveLength(1);
  });
});

describe("queue navigation", () => {
  const items = [
    { cardId: 1, isNew: false },
    { cardId: 2, isNew: false },
    { cardId: 3, isNew: true },
    { cardId: 4, isNew: true },
    { cardId: 5, isNew: true },
  ];

  it("walks the queue and reports when it is done", () => {
    let state = { items, position: 0 };
    expect(currentItem(state)?.cardId).toBe(1);
    expect(remaining(state)).toBe(5);
    state = advance(state);
    expect(currentItem(state)?.cardId).toBe(2);
    expect(isFinished(state)).toBe(false);
    for (let i = 0; i < 10; i++) state = advance(state);
    expect(isFinished(state)).toBe(true);
    expect(currentItem(state)).toBeNull();
    expect(state.position).toBe(items.length);
  });

  it("re-queues the current card N cards later and marks it as not new", () => {
    const state = requeueCurrent({ items, position: 0 }, 2);
    expect(state.position).toBe(1);
    expect(state.items.map((i) => i.cardId)).toEqual([1, 2, 3, 1, 4, 5]);
    expect(state.items[3]).toEqual({ cardId: 1, isNew: false });
  });

  it("appends to the end when fewer than N cards are left", () => {
    const state = requeueCurrent({ items, position: 3 }, 3);
    expect(state.items.map((i) => i.cardId)).toEqual([1, 2, 3, 4, 5, 4]);
    expect(state.position).toBe(4);
  });

  it("is a no-op on an exhausted queue", () => {
    const exhausted = { items, position: items.length };
    expect(requeueCurrent(exhausted)).toBe(exhausted);
  });
});

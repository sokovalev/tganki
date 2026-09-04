import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionService,
  EXTRA_NEW_BATCH,
  rewindQueue,
  SNOWBALL_THRESHOLD,
  skipCurrent,
} from "../src/services/sessionService.js";
import { createFakePort, type FakeCard, makeCard, makeUser } from "./helpers/fakeSession.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const CHAT = 555;

/** A card that is already in review and overdue, so it lands in the due queue. */
function dueCard(id: number, minutesOverdue: number): FakeCard {
  const card = makeCard(id, NOW);
  card.state = {
    ...card.state,
    state: 2,
    stability: 10,
    difficulty: 5,
    reps: 3,
    due: new Date(NOW.getTime() - minutesOverdue * 60_000),
    lastReview: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000),
  };
  return card;
}

describe("pure queue operations", () => {
  it("moves a skipped card to the end and buries it on the second skip", () => {
    const first = skipCurrent({
      items: [
        { cardId: 1, isNew: false },
        { cardId: 2, isNew: false },
      ],
      position: 0,
    });
    expect(first.buried).toBe(false);
    expect(first.state.items.map((item) => item.cardId)).toEqual([1, 2, 1]);
    expect(first.state.position).toBe(1);

    const second = skipCurrent({ items: first.state.items, position: 2 });
    expect(second.buried).toBe(true);
    expect(second.state.position).toBe(3);
  });

  it("rewinds the queue and drops the copy the re-queue inserted", () => {
    const rewound = rewindQueue(
      {
        items: [
          { cardId: 1, isNew: true },
          { cardId: 2, isNew: false },
          { cardId: 1, isNew: false },
        ],
        position: 1,
      },
      1,
    );
    expect(rewound.position).toBe(0);
    expect(rewound.items.map((item) => item.cardId)).toEqual([1, 2]);
  });
});

describe("session service", () => {
  let fake: ReturnType<typeof createFakePort>;
  let service: ReturnType<typeof createSessionService>;
  const user = makeUser();

  beforeEach(() => {
    fake = createFakePort([dueCard(1, 60), dueCard(2, 30)]);
    service = createSessionService(fake.port);
  });

  it("builds a session from overdue cards", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    expect(started.kind).toBe("card");
    if (started.kind !== "card") return;
    expect(started.total).toBe(2);
    expect(started.position).toBe(0);
    // Most overdue first.
    expect(started.card.cardId).toBe(1);
    expect(started.stage).toBe("question");
  });

  it("reports an empty queue with the next due time", async () => {
    const empty = createFakePort([], {
      nextDue: { at: new Date(NOW.getTime() + 3600_000), count: 14 },
    });
    const service2 = createSessionService(empty.port);
    const result = await service2.start({ user, deckId: null, chatId: CHAT, now: NOW });
    expect(result.kind).toBe("empty");
    if (result.kind !== "empty") return;
    expect(result.nextCount).toBe(14);
  });

  it("holds new cards back when the backlog snowballs", async () => {
    fake.state.remainingDue = SNOWBALL_THRESHOLD + 1;
    fake.state.newCandidateIds = [3];
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    expect(started.kind).toBe("card");
    if (started.kind !== "card") return;
    expect(started.snowball).toBe(true);
    expect(started.total).toBe(2);
  });

  it('adds exactly five cards for "Ещё 5 новых" once the allowance is spent', async () => {
    const empty = createFakePort([], {
      introducedToday: 10,
      introducedAt: new Date(NOW.getTime() - 3600_000),
      newCandidateIds: [],
      newLimit: 10,
    });
    // Ten unseen notes wait behind an exhausted daily allowance.
    empty.state.newCandidateIds = Array.from({ length: 10 }, (_, i) => 100 + i);
    for (const id of empty.state.newCandidateIds) {
      empty.state.cards.set(id, makeCard(id, NOW));
    }
    const service2 = createSessionService(empty.port);

    expect((await service2.start({ user, deckId: null, chatId: CHAT, now: NOW })).kind).toBe(
      "empty",
    );

    const extra = await service2.start({
      user,
      deckId: null,
      chatId: CHAT,
      now: NOW,
      extraNew: EXTRA_NEW_BATCH,
    });
    expect(extra.kind).toBe("card");
    if (extra.kind !== "card") return;
    expect(extra.total).toBe(EXTRA_NEW_BATCH);
    expect(extra.isNew).toBe(true);
  });

  it("re-queues a short-interval rating and finishes when the queue drains", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");

    // "Снова" schedules a learning step of a minute → the card comes back.
    const again = await service.rate({
      user,
      session: started.session,
      position: 0,
      rating: 1,
      now: NOW,
    });
    expect(again.kind).toBe("card");
    if (again.kind !== "card") return;
    expect(again.total).toBe(3);
    expect(again.position).toBe(1);
    expect(again.session.stats).toMatchObject({ reviewed: 1, again: 1 });

    // "Легко" on a review card schedules months out → it leaves the session.
    const easy = await service.rate({
      user,
      session: again.session,
      position: 1,
      rating: 4,
      now: NOW,
    });
    if (easy.kind !== "card") throw new Error("expected a card");
    expect(easy.position).toBe(2);
    expect(easy.card.cardId).toBe(1);

    fake.state.remainingDue = 15;
    const last = await service.rate({
      user,
      session: easy.session,
      position: 2,
      rating: 4,
      now: NOW,
    });
    expect(last.kind).toBe("summary");
    if (last.kind !== "summary") return;
    expect(last.stats.reviewed).toBe(3);
    expect(last.accuracy).toBe(67);
    expect(last.remainingDue).toBe(15);
    expect(fake.state.sessions[0]!.status).toBe("finished");
  });

  it("starts a fresh session for the remaining due cards", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    await service.finish({ user, session: started.session, now: NOW });

    const next = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    expect(next.kind).toBe("card");
    expect(fake.state.sessions).toHaveLength(2);
    expect(fake.state.sessions[0]!.status).toBe("finished");
  });

  it("ignores a second tap on a position that was already rated", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const first = await service.rate({
      user,
      session: started.session,
      position: 0,
      rating: 3,
      now: NOW,
    });
    expect(first.kind).not.toBe("stale");

    const doubleTap = await service.rate({
      user,
      session: first.kind === "card" ? first.session : started.session,
      position: 0,
      rating: 3,
      now: NOW,
    });
    expect(doubleTap.kind).toBe("stale");
    expect(fake.state.logs).toHaveLength(1);
  });

  it("undoes the last rating and makes the card current again", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const before = { ...fake.state.cards.get(1)!.state };

    const rated = await service.rate({
      user,
      session: started.session,
      position: 0,
      rating: 1,
      now: NOW,
    });
    if (rated.kind !== "card") throw new Error("expected a card");
    expect(fake.state.logs).toHaveLength(1);

    const undone = await service.undo({ user, session: rated.session, now: NOW });
    if ("kind" in undone && undone.kind === "nothing") throw new Error("expected a view");
    expect(undone.position).toBe(0);
    expect(undone.card.cardId).toBe(1);
    expect(undone.session.stats).toMatchObject({ reviewed: 0, again: 0 });
    expect(undone.session.queue).toHaveLength(2);
    expect(fake.state.logs).toHaveLength(0);
    expect(fake.state.cards.get(1)!.state.due.toISOString()).toBe(before.due.toISOString());
  });

  it("has nothing to undo before the first rating", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    expect(await service.undo({ user, session: started.session, now: NOW })).toEqual({
      kind: "nothing",
    });
  });

  it("skips a card to the end and buries it on the second skip", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");

    const first = await service.skip({ user, session: started.session, position: 0, now: NOW });
    if (!("view" in first)) throw new Error("expected a view");
    expect(first.buried).toBe(false);
    expect(first.view.kind).toBe("card");
    if (first.view.kind !== "card") return;
    expect(first.view.card.cardId).toBe(2);
    expect(first.view.session.queue).toHaveLength(3);

    const second = await service.skip({ user, session: first.view.session, position: 1, now: NOW });
    if (!("view" in second)) throw new Error("expected a view");
    expect(second.view.kind).toBe("card");
    if (second.view.kind !== "card") return;
    expect(second.view.card.cardId).toBe(1);

    // Third tap is the second skip of card 1 → buried and dropped from the queue.
    const third = await service.skip({ user, session: second.view.session, position: 2, now: NOW });
    if (!("view" in third)) throw new Error("expected a view");
    expect(third.buried).toBe(true);
    expect(fake.state.cards.get(1)!.buriedUntil).not.toBeNull();
    if (third.view.kind !== "card") throw new Error("expected a card");

    const fourth = await service.skip({ user, session: third.view.session, position: 3, now: NOW });
    if (!("view" in fourth)) throw new Error("expected a view");
    expect(fourth.buried).toBe(true);
    expect(fake.state.cards.get(2)!.buriedUntil).not.toBeNull();
    expect(fourth.view.kind).toBe("summary");
  });

  it("refuses to skip a stale position", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const result = await service.skip({ user, session: started.session, position: 3, now: NOW });
    expect(result).toEqual({ kind: "stale" });
  });

  it("suspends, buries, reports and deletes from the card menu", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");

    const reported = await service.cardAction({
      user,
      session: started.session,
      position: 0,
      action: "report",
      now: NOW,
    });
    expect(fake.state.reports).toEqual([{ noteId: 101, userId: user.id }]);
    // Reporting keeps the card in the session.
    if ("kind" in reported && reported.kind === "card") expect(reported.card.cardId).toBe(1);

    const suspended = await service.cardAction({
      user,
      session: started.session,
      position: 0,
      action: "suspend",
      now: NOW,
    });
    expect(fake.state.cards.get(1)!.suspended).toBe(true);
    if ("kind" in suspended && suspended.kind === "card") {
      expect(suspended.card.cardId).toBe(2);
      expect(suspended.session.queue).toHaveLength(1);
    }
  });

  it("marks the leech in the summary once it lapses too often", async () => {
    fake.state.cards.get(2)!.state.lapses = 8;
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const summary = await service.finish({ user, session: started.session, now: NOW });
    expect(summary.leech).toEqual({ cardId: 2, front: "word2" });
  });

  it("abandons a session that has been idle for half a day", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const later = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    expect(await service.current(user, later)).toBeNull();
    expect(fake.state.sessions[0]!.status).toBe("abandoned");
  });

  it("keeps the streak up to date on the first rating of the day", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    await service.rate({ user, session: started.session, position: 0, rating: 3, now: NOW });
    expect(fake.state.streakSaves).toEqual([{ streak: 1, lastDay: "2026-01-10" }]);
  });
});

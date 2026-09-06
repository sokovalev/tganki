import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REQUEUES } from "../src/core/queue.js";
import type { User } from "../src/db/schema.js";
import {
  createSessionService,
  EXTRA_NEW_BATCH,
  INTRO_RETURN_MS,
  rewindQueue,
  type SessionView,
  SNOWBALL_THRESHOLD,
  skipCurrent,
} from "../src/services/sessionService.js";
import {
  createFakePort,
  type FakeCard,
  type FakeNote,
  makeCard,
  makeUser,
  normalizeFront,
} from "./helpers/fakeSession.js";

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

/** A card in review, due far in the future, so it only exists as a sibling. */
function reviewedCard(id: number, overrides: Partial<FakeCard> = {}): FakeCard {
  const card = makeCard(id, NOW, overrides);
  card.state = {
    ...card.state,
    state: 2,
    stability: 10,
    difficulty: 5,
    reps: 3,
    due: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    lastReview: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
  };
  return card;
}

describe("new candidates", () => {
  const user = makeUser();

  it("skips a word the user switched off", async () => {
    const fake = createFakePort([makeCard(10, NOW, { front: "Water " }), makeCard(11, NOW)], {
      newCandidateIds: [10, 11],
      knownWords: [{ langFrom: "en", frontNorm: normalizeFront("water") }],
    });
    const service = createSessionService(fake.port);
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    expect(started.total).toBe(1);
    expect(started.card.cardId).toBe(11);
  });

  it("skips a word that is already being learned through another deck", async () => {
    const fake = createFakePort(
      [
        // The same word, in another deck: a different note, same language.
        reviewedCard(5, { noteId: 500, deckId: 2, front: "bread" }),
        makeCard(10, NOW, { noteId: 510, deckId: 3, front: "Bread" }),
        makeCard(11, NOW, { noteId: 511, deckId: 3, front: "butter" }),
      ],
      { newCandidateIds: [10, 11] },
    );
    const service = createSessionService(fake.port);
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    expect(started.session.queue.map((item) => item.cardId)).toEqual([11]);
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

  it('switches a word off everywhere on "Знаю"', async () => {
    // Card 3 is the same word in another deck, card 4 is a different word.
    fake.state.cards.set(3, makeCard(3, NOW, { noteId: 300, deckId: 2, front: " Word1 " }));
    fake.state.cards.set(4, makeCard(4, NOW, { noteId: 400, deckId: 2, front: "other" }));
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");

    const result = await service.markKnown({
      user,
      session: started.session,
      position: 0,
      now: NOW,
    });
    if ("kind" in result) throw new Error("expected a view");
    expect(result.word).toBe("word1");
    expect(fake.state.knownWords).toEqual([{ langFrom: "en", frontNorm: "word1" }]);
    // This card and its twin in the other deck are off; the other word is not.
    expect(fake.state.cards.get(1)!.suspended).toBe(true);
    expect(fake.state.cards.get(1)!.suspendedReason).toBe("known");
    expect(fake.state.cards.get(3)!.suspended).toBe(true);
    expect(fake.state.cards.get(4)!.suspended).toBe(false);
    // No rating: no review log, and the session counters stay where they were.
    expect(fake.state.logs).toHaveLength(0);
    expect(result.view.session.stats).toMatchObject({ reviewed: 0, newLearned: 0 });
    if (result.view.kind !== "card") throw new Error("expected a card");
    expect(result.view.card.cardId).toBe(2);
    expect(result.view.position).toBe(1);
  });

  it("drops the re-queued copy of a card that is switched off", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    // A session where card 1 is current and waits at the end for its next step.
    const queue = [
      { cardId: 1, isNew: false },
      { cardId: 2, isNew: false },
      { cardId: 1, isNew: false, notBefore: NOW.getTime() + 60_000, requeues: 1 },
    ];
    Object.assign(fake.state.sessions[0]!, { queue, position: 0 });

    const result = await service.markKnown({
      user,
      session: { ...started.session, queue, position: 0 },
      position: 0,
      now: NOW,
    });
    if ("kind" in result) throw new Error("expected a view");
    expect(result.view.session.queue.map((item) => item.cardId)).toEqual([1, 2]);
    if (result.view.kind !== "card") throw new Error("expected a card");
    expect(result.view.card.cardId).toBe(2);
  });

  it("ignores a second tap on a card that is already switched off", async () => {
    const started = await service.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const first = await service.markKnown({
      user,
      session: started.session,
      position: 0,
      now: NOW,
    });
    if ("kind" in first) throw new Error("expected a view");
    const second = await service.markKnown({
      user,
      session: started.session,
      position: 0,
      now: NOW,
    });
    expect(second).toEqual({ kind: "stale" });
    expect(fake.state.knownWords).toHaveLength(1);
  });

  it('finishes the session when "Знаю" takes the last card', async () => {
    const single = createFakePort([dueCard(1, 60)], { remainingDue: 4 });
    const service2 = createSessionService(single.port);
    const started = await service2.start({ user, deckId: null, chatId: CHAT, now: NOW });
    if (started.kind !== "card") throw new Error("expected a card");
    const result = await service2.markKnown({
      user,
      session: started.session,
      position: 0,
      now: NOW,
    });
    if ("kind" in result) throw new Error("expected a view");
    expect(result.view.kind).toBe("summary");
    if (result.view.kind !== "summary") return;
    expect(result.view.stats.reviewed).toBe(0);
    expect(result.view.remainingDue).toBe(4);
    expect(single.state.sessions[0]!.status).toBe("finished");
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

const DEFAULT_USER = makeUser();

/** Distractor pool of the deck: five adjectives-and-a-noun, one deck apart. */
const DECK_NOTES: FakeNote[] = [
  { noteId: 201, deckId: 1, back: "упрямый", tag: "adjective" },
  { noteId: 202, deckId: 1, back: "довольный", tag: "adjective" },
  { noteId: 203, deckId: 1, back: "усталый", tag: "adjective" },
  { noteId: 204, deckId: 1, back: "хлеб", tag: "noun" },
  { noteId: 205, deckId: 1, back: "невероятно долгий и подробный перевод", tag: "adjective" },
  { noteId: 206, deckId: 2, back: "из чужой деки", tag: "adjective" },
];

/** The card the question is about, plus a second one to move on to. */
function cards(overrides: Partial<FakeCard> = {}): FakeCard[] {
  return [
    makeCard(1, NOW, {
      noteId: 101,
      front: "reluctant",
      back: "неохотный",
      tag: "adjective",
      ...overrides,
    }),
    makeCard(2, NOW, { noteId: 102, front: "table", back: "стол", tag: "noun" }),
  ];
}

function setup(
  options: { cards?: FakeCard[]; deckNotes?: FakeNote[]; user?: User; proEnabled?: boolean } = {},
) {
  const fake = createFakePort(options.cards ?? cards(), {
    deckNotes: options.deckNotes ?? DECK_NOTES,
  });
  const service = createSessionService(fake.port, { proEnabled: options.proEnabled ?? false });
  return { fake, service, user: options.user ?? DEFAULT_USER };
}

async function open(setUp: ReturnType<typeof setup>, cardIds = [1, 2], now = NOW) {
  const view = await setUp.service.startWith({
    user: setUp.user,
    chatId: CHAT,
    deckId: 1,
    cardIds,
    now,
  });
  if (!view) throw new Error("expected a card");
  return view;
}

/** Taps «▶️ Дальше» on the «знакомство» screen and returns the next card. */
async function introduce(setUp: ReturnType<typeof setup>, view: SessionView, now = NOW) {
  const result = await setUp.service.introduce({
    user: setUp.user,
    session: view.session,
    position: view.position,
    now,
  });
  if ("kind" in result) throw new Error("expected a view");
  return result;
}

/**
 * Opens a session and walks every «знакомство» screen, so the first card comes
 * back for step two of the ladder — its first real test (SPEC §3.2).
 */
async function openTest(setUp: ReturnType<typeof setup>, cardIds = [1, 2], now = NOW) {
  let view = await open(setUp, cardIds, now);
  for (let guard = 0; view.stage === "intro" && guard <= cardIds.length; guard += 1) {
    const result = await introduce(setUp, view, now);
    if (result.view.kind !== "card") throw new Error("expected a card");
    view = result.view;
  }
  return view;
}

/**
 * «Выбор из четырёх» (SPEC §3.2): step two of the ladder — the first real test
 * of a `recognition` card, once it has been introduced.
 */
describe("choice question", () => {
  it("offers four translations and prefers the part of speech and the length", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    const choices = view.choices;
    if (!choices) throw new Error("expected the choice question");

    expect(choices).toHaveLength(4);
    const backs = choices.map((option) => option.back);
    expect(backs).toContain("неохотный");
    // Three adjectives are available, so the noun and the other deck stay out;
    // the wildly longer translation would give the answer away.
    expect(backs).not.toContain("хлеб");
    expect(backs).not.toContain("из чужой деки");
    expect(backs).not.toContain("невероятно долгий и подробный перевод");
    expect(new Set(backs).size).toBe(4);
  });

  it("never repeats the right answer among the options", async () => {
    const fixture = setup({
      deckNotes: [{ noteId: 301, deckId: 1, back: " Неохотный ", tag: "adjective" }, ...DECK_NOTES],
    });
    const view = await openTest(fixture);
    expect(view.choices?.map((option) => option.noteId)).not.toContain(301);
    expect(view.choices).toHaveLength(4);
  });

  it("falls back to the reveal flow in a deck of fewer than four notes", async () => {
    const fixture = setup({ deckNotes: DECK_NOTES.slice(0, 2) });
    expect((await openTest(fixture)).choices).toBeNull();
  });

  it("freezes the options in the queue item, so a re-render asks the same", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    const stored = fixture.fake.state.sessions[0]?.queue[view.position]?.choice;
    expect(stored?.noteIds).toEqual(view.choices?.map((option) => option.noteId));

    // Through the database and back: the order must survive the round trip.
    const reloaded = JSON.parse(
      JSON.stringify(fixture.fake.state.sessions[0]),
    ) as typeof view.session;
    reloaded.startedAt = NOW;
    const again = await fixture.service.render(reloaded, fixture.user, NOW, "question");
    expect(again?.choices).toEqual(view.choices);
  });

  it("rates the right option Хорошо and stops on the answer screen with «Верно»", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    const right = view.choices?.findIndex((option) => option.noteId === 101) ?? -1;
    expect(right).toBeGreaterThanOrEqual(0);

    const result = await fixture.service.choose({
      user: fixture.user,
      session: view.session,
      position: view.position,
      option: right,
      now: NOW,
    });
    if (result.kind !== "card") throw new Error("expected a card");
    expect(result.correct).toBe(true);
    expect(fixture.fake.state.logs.map((log) => log.rating)).toEqual([3]);
    expect(result.session.stats).toMatchObject({ reviewed: 1, good: 1, newLearned: 1 });
    // The tap already rated the card; the answer stays on screen to be read.
    expect(result.stage).toBe("answer");
    expect(result.card.cardId).toBe(1);
    expect(result.choiceResult).toBe("hit");
    expect(result.session.position).toBe(view.position + 1);

    const next = await fixture.service.next({
      user: fixture.user,
      session: result.session,
      position: result.session.position,
      now: NOW,
    });
    if (next.kind !== "card") throw new Error("expected the next card");
    // The second card had its introduction while the first one waited, so it
    // comes up as a question, not as a presentation.
    expect(next.card.cardId).toBe(2);
    expect(next.stage).toBe("question");
  });

  it("rates a wrong option Снова and stops on the answer with the right one", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    const wrong = view.choices?.findIndex((option) => option.noteId !== 101) ?? -1;

    const result = await fixture.service.choose({
      user: fixture.user,
      session: view.session,
      position: view.position,
      option: wrong,
      now: NOW,
    });
    if (result.kind !== "card") throw new Error("expected a card");
    expect(result.correct).toBe(false);
    expect(result.stage).toBe("answer");
    expect(result.choiceResult).toBe("miss");
    expect(result.card.cardId).toBe(1);
    expect(result.card.back).toBe("неохотный");
    expect(result.canUndo).toBe(true);
    expect(fixture.fake.state.logs.map((log) => log.rating)).toEqual([1]);
    expect(result.session.stats).toMatchObject({ reviewed: 1, again: 1 });
    // Both cards were introduced, card 1 was tested and is back for its
    // learning step; the session waits for «Дальше» rather than ending under
    // the correction.
    expect(result.session.queue.map((item) => item.cardId)).toEqual([1, 2, 1, 2, 1]);
    expect(fixture.fake.state.sessions[0]?.status).toBe("active");

    const next = await fixture.service.next({
      user: fixture.user,
      session: result.session,
      position: result.position,
      now: NOW,
    });
    if ("kind" in next && next.kind === "stale") throw new Error("expected a view");
    if (next.kind !== "card") throw new Error("expected a card");
    expect(next.card.cardId).toBe(2);
  });

  it("ignores a tap on a position that was already answered", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    // The handler always reloads the session, so a second tap sees the queue
    // the first one moved on.
    const live = () => fixture.fake.state.sessions[0]!;
    expect(
      await fixture.service.choose({
        user: fixture.user,
        session: live(),
        position: view.position - 1,
        option: 0,
        now: NOW,
      }),
    ).toEqual({ kind: "stale" });

    const first = await fixture.service.choose({
      user: fixture.user,
      session: live(),
      position: view.position,
      option: 0,
      now: NOW,
    });
    expect(first.kind).not.toBe("stale");
    const second = await fixture.service.choose({
      user: fixture.user,
      session: live(),
      position: view.position,
      option: 0,
      now: NOW,
    });
    expect(second).toEqual({ kind: "stale" });
    expect(fixture.fake.state.logs).toHaveLength(1);
  });

  it("undoes the rating a tap applied by itself", async () => {
    const fixture = setup();
    const view = await openTest(fixture);
    const wrong = view.choices?.findIndex((option) => option.noteId !== 101) ?? -1;
    const missed = await fixture.service.choose({
      user: fixture.user,
      session: view.session,
      position: view.position,
      option: wrong,
      now: NOW,
    });
    if (missed.kind !== "card") throw new Error("expected a card");

    const undone = await fixture.service.undo({
      user: fixture.user,
      session: missed.session,
      now: NOW,
    });
    if ("kind" in undone && undone.kind === "nothing") throw new Error("expected a view");
    expect(fixture.fake.state.logs).toHaveLength(0);
    expect(undone.position).toBe(view.position);
    expect(undone.card.cardId).toBe(1);
    expect(undone.session.stats).toMatchObject({ reviewed: 0, again: 0 });
    // The same question comes back, options and order included — and not the
    // introduction, which this card has already had (SPEC §3.2).
    expect(undone.stage).toBe("question");
    expect(undone.choices).toEqual(view.choices);
  });

  it("counts an automatic rating in the session summary", async () => {
    const fixture = setup();
    // One card only: the introduction, the choice and the learning step that
    // «Хорошо» schedules all happen inside this session.
    const view = await openTest(fixture, [1]);
    const right = view.choices?.findIndex((option) => option.noteId === 101) ?? -1;

    const result = await fixture.service.choose({
      user: fixture.user,
      session: view.session,
      position: view.position,
      option: right,
      now: NOW,
    });
    if (result.kind !== "card") throw new Error("expected the answer screen");
    expect(result.choiceResult).toBe("hit");

    // «Дальше» brings the card back for its learning step — step three of the
    // ladder, the plain reveal flow, because it has a rating behind it now.
    const again = await fixture.service.next({
      user: fixture.user,
      session: result.session,
      position: result.session.position,
      now: NOW,
    });
    if (again.kind !== "card") throw new Error("expected the learning step");
    expect(again.stage).toBe("question");
    expect(again.choices).toBeNull();

    const summary = await fixture.service.rate({
      user: fixture.user,
      session: again.session,
      position: again.position,
      rating: 4,
      now: NOW,
    });
    if (summary.kind !== "summary") throw new Error("expected the summary");
    expect(summary.stats).toMatchObject({ reviewed: 2, good: 1, easy: 1, newLearned: 1 });
    expect(fixture.fake.state.sessions[0]?.status).toBe("finished");
  });

  it("keeps the reveal flow when the setting is off", async () => {
    const fixture = setup({ user: makeUser({ newCardStyle: "reveal" }) });
    const view = await openTest(fixture);
    expect(view.stage).toBe("question");
    expect(view.choices).toBeNull();
  });

  it("keeps the reveal flow once the card has a rating behind it", async () => {
    const seen = makeCard(1, NOW, {
      noteId: 101,
      front: "reluctant",
      back: "неохотный",
      tag: "adjective",
    });
    seen.state = { ...seen.state, state: 2, stability: 12, difficulty: 5, reps: 1 };
    const view = await openTest(setup({ cards: [seen] }), [1]);
    // A card that is no longer new is neither introduced nor asked by choice.
    expect(view.stage).toBe("question");
    expect(view.choices).toBeNull();
  });

  it("keeps the reveal flow for a reverse card", async () => {
    const fixture = setup({ cards: cards({ mode: "recall" }) });
    expect((await openTest(fixture)).choices).toBeNull();
  });

  it("is a Pro presentation while PRO_ENABLED is on (SPEC §9.1)", async () => {
    const free = setup({ proEnabled: true });
    expect((await openTest(free)).choices).toBeNull();

    const pro = setup({
      proEnabled: true,
      user: makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + 86_400_000) }),
    });
    expect((await openTest(pro)).choices).toHaveLength(4);
  });
});

/**
 * «Знакомство» (SPEC §3.2): step one of the ladder — a new card is presented
 * before it is ever asked about, and the presentation is not a review.
 */
describe("introduction", () => {
  it("opens a new card with the presentation, never with a question", async () => {
    const fixture = setup();
    const view = await open(fixture);
    expect(view.stage).toBe("intro");
    expect(view.isNew).toBe(true);
    expect(view.choices).toBeNull();
    expect(view.previews).toBeNull();
    // Nothing was rated: no log, no counters, nothing to undo.
    expect(fixture.fake.state.logs).toHaveLength(0);
    expect(view.session.stats).toMatchObject({ reviewed: 0, newLearned: 0 });
    expect(view.canUndo).toBe(false);

    // A stale «Показать ответ» cannot skip the presentation.
    const shown = await fixture.service.render(view.session, fixture.user, NOW, "answer");
    expect(shown?.stage).toBe("intro");
  });

  it("presents new cards a session builds for itself as well", async () => {
    const fake = createFakePort(cards(), { deckNotes: DECK_NOTES, newCandidateIds: [1, 2] });
    const service = createSessionService(fake.port);
    const started = await service.start({
      user: DEFAULT_USER,
      deckId: null,
      chatId: CHAT,
      now: NOW,
    });
    if (started.kind !== "card") throw new Error("expected a card");
    expect(started.stage).toBe("intro");
    expect(started.card.cardId).toBe(1);
  });

  it("«Дальше» re-queues the card a minute later without rating it", async () => {
    const fixture = setup();
    const view = await open(fixture, [1]);
    const result = await introduce(fixture, view);

    expect(result.cardId).toBe(1);
    expect(fixture.fake.state.logs).toHaveLength(0);
    const queue = fixture.fake.state.sessions[0]?.queue ?? [];
    expect(queue.map((item) => item.cardId)).toEqual([1, 1]);
    expect(queue[1]).toMatchObject({
      cardId: 1,
      isNew: true,
      introduced: true,
      notBefore: NOW.getTime() + INTRO_RETURN_MS,
    });
    // The introduction is not a return caused by a rating.
    expect(queue[1]?.requeues).toBeUndefined();
    expect(queue[0]?.introduced).toBe(true);

    // Nothing else is left, so the card is shown early — as a question now.
    if (result.view.kind !== "card") throw new Error("expected a card");
    expect(result.view.stage).toBe("question");
    expect(result.view.card.cardId).toBe(1);
    expect(result.view.session.stats).toMatchObject({ reviewed: 0, newLearned: 0 });
    // The presentation is persisted on the card, not only on the queue item.
    expect(fixture.fake.state.cards.get(1)?.state.introducedAt).toEqual(NOW);
  });

  it("never presents the card a second time, in any later session", async () => {
    const fixture = setup();
    const intro = await open(fixture, [1]);
    expect(intro.stage).toBe("intro");
    await introduce(fixture, intro);
    expect(fixture.fake.state.cards.get(1)?.state.introducedAt).toEqual(NOW);

    // «Закончить»: the session ends before the card was ever rated.
    await fixture.service.finish({
      user: fixture.user,
      session: fixture.fake.state.sessions[0]!,
      now: NOW,
    });

    // Tomorrow's session finds a card that is still New and still unrated —
    // and opens it at step two, the recognition step, not at the presentation.
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const again = await open(fixture, [1], tomorrow);
    expect(again.session.id).not.toBe(intro.session.id);
    expect(again.stage).toBe("question");
    expect(again.choices).toHaveLength(4);
    expect(fixture.fake.state.cards.get(1)?.state.reps).toBe(0);
  });

  it("opens an already introduced card with «Показать ответ» in the reveal style", async () => {
    const fixture = setup({ user: makeUser({ newCardStyle: "reveal" }) });
    await introduce(fixture, await open(fixture, [1]));
    await fixture.service.finish({
      user: fixture.user,
      session: fixture.fake.state.sessions[0]!,
      now: NOW,
    });

    const again = await open(fixture, [1], new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    expect(again.stage).toBe("question");
    expect(again.choices).toBeNull();
  });

  it("keeps the mark when the first rating is undone", async () => {
    const fixture = setup({ user: makeUser({ newCardStyle: "reveal" }) });
    const asked = await openTest(fixture, [1]);
    expect(fixture.fake.state.cards.get(1)?.state.introducedAt).toEqual(NOW);

    const rated = await fixture.service.rate({
      user: fixture.user,
      session: asked.session,
      position: asked.position,
      rating: 3,
      now: NOW,
    });
    if (rated.kind !== "card") throw new Error("expected the learning step");

    const undone = await fixture.service.undo({
      user: fixture.user,
      session: rated.session,
      now: NOW,
    });
    if ("kind" in undone && undone.kind === "nothing") throw new Error("expected a view");
    // The rating is rolled back, the presentation is not: it really happened.
    expect(fixture.fake.state.logs).toHaveLength(0);
    expect(fixture.fake.state.cards.get(1)?.state.reps).toBe(0);
    expect(fixture.fake.state.cards.get(1)?.state.introducedAt).toEqual(NOW);
    expect(undone.stage).toBe("question");
  });

  it("re-offers a card introduced yesterday and never rated, at the recognition step", async () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const carried = makeCard(1, yesterday, {
      noteId: 101,
      front: "reluctant",
      back: "неохотный",
      tag: "adjective",
    });
    // Yesterday's session presented it and ended before the first rating.
    carried.state = { ...carried.state, introducedAt: yesterday };
    const fake = createFakePort([carried], { deckNotes: DECK_NOTES, newCandidateIds: [1] });
    const service = createSessionService(fake.port);

    const started = await service.start({
      user: DEFAULT_USER,
      deckId: null,
      chatId: CHAT,
      now: NOW,
    });
    if (started.kind !== "card") throw new Error("expected a card");
    // Nothing was rated yesterday, so the card is still New: today's queue
    // takes it back, and today's allowance — which counts first ratings, not
    // presentations (SPEC §3.1) — is untouched by yesterday's introduction.
    expect(started.card.cardId).toBe(1);
    expect(started.isNew).toBe(true);
    expect(started.stage).toBe("question");
    expect(started.choices).toHaveLength(4);
  });

  it("lets other cards in before the introduced one comes back", async () => {
    const fixture = setup();
    const view = await open(fixture);
    const result = await introduce(fixture, view);
    if (result.view.kind !== "card") throw new Error("expected a card");
    // Card 2 is due now, the introduced card 1 waits for its minute.
    expect(result.view.card.cardId).toBe(2);
    expect(result.view.stage).toBe("intro");
  });

  it("walks the ladder: introduction, then choice, then the reveal flow", async () => {
    const fixture = setup();
    const intro = await open(fixture, [1]);
    expect(intro.stage).toBe("intro");

    const asked = (await introduce(fixture, intro)).view;
    if (asked.kind !== "card") throw new Error("expected a card");
    expect(asked.stage).toBe("question");
    expect(asked.choices).toHaveLength(4);
    // The options are frozen on the queue item the introduction re-queued.
    expect(fixture.fake.state.sessions[0]?.queue[asked.position]?.choice?.noteIds).toEqual(
      asked.choices?.map((option) => option.noteId),
    );

    const right = asked.choices?.findIndex((option) => option.noteId === 101) ?? -1;
    const answered = await fixture.service.choose({
      user: fixture.user,
      session: asked.session,
      position: asked.position,
      option: right,
      now: NOW,
    });
    if (answered.kind !== "card") throw new Error("expected the answer screen");

    const reveal = await fixture.service.next({
      user: fixture.user,
      session: answered.session,
      position: answered.session.position,
      now: NOW,
    });
    if (reveal.kind !== "card") throw new Error("expected the learning step");
    // One rating behind it: no introduction, no choice, just «Показать ответ».
    expect(reveal.stage).toBe("question");
    expect(reveal.choices).toBeNull();
    expect(fixture.fake.state.cards.get(1)?.state.reps).toBe(1);
  });

  it("introduces a card once per session, even after an undo", async () => {
    const fixture = setup();
    const asked = await openTest(fixture, [1]);
    const wrong = asked.choices?.findIndex((option) => option.noteId !== 101) ?? -1;
    const missed = await fixture.service.choose({
      user: fixture.user,
      session: asked.session,
      position: asked.position,
      option: wrong,
      now: NOW,
    });
    if (missed.kind !== "card") throw new Error("expected a card");

    const undone = await fixture.service.undo({
      user: fixture.user,
      session: missed.session,
      now: NOW,
    });
    if ("kind" in undone && undone.kind === "nothing") throw new Error("expected a view");
    // The rating is gone, the presentation does not come back with it.
    expect(fixture.fake.state.logs).toHaveLength(0);
    expect(undone.stage).toBe("question");
    expect(undone.choices).toEqual(asked.choices);
    expect(undone.session.queue.map((item) => item.cardId)).toEqual([1, 1]);
  });

  it("presents the card before the reveal flow too", async () => {
    const fixture = setup({ user: makeUser({ newCardStyle: "reveal" }) });
    const intro = await open(fixture, [1]);
    expect(intro.stage).toBe("intro");
    const asked = (await introduce(fixture, intro)).view;
    if (asked.kind !== "card") throw new Error("expected a card");
    expect(asked.stage).toBe("question");
    expect(asked.choices).toBeNull();
  });

  it("switches the word off from the presentation screen", async () => {
    const fixture = setup();
    const view = await open(fixture);
    const result = await fixture.service.markKnown({
      user: fixture.user,
      session: view.session,
      position: view.position,
      now: NOW,
    });
    if ("kind" in result) throw new Error("expected a view");
    expect(result.word).toBe("reluctant");
    expect(fixture.fake.state.cards.get(1)?.suspended).toBe(true);
    expect(fixture.fake.state.logs).toHaveLength(0);
    if (result.view.kind !== "card") throw new Error("expected a card");
    // The session moves on to the next card, which gets its own presentation.
    expect(result.view.card.cardId).toBe(2);
    expect(result.view.stage).toBe("intro");
    expect(result.view.session.stats).toMatchObject({ reviewed: 0, newLearned: 0 });
  });

  it("leaves the session summary untouched", async () => {
    const fixture = setup();
    const first = await open(fixture);
    const second = (await introduce(fixture, first)).view;
    if (second.kind !== "card") throw new Error("expected a card");
    await introduce(fixture, second);

    const live = fixture.fake.state.sessions[0]!;
    const summary = await fixture.service.finish({ user: fixture.user, session: live, now: NOW });
    expect(summary.stats).toMatchObject({
      reviewed: 0,
      again: 0,
      good: 0,
      newLearned: 0,
    });
    expect(summary.accuracy).toBe(0);
  });

  it("does not spend one of the card's returns", async () => {
    const fixture = setup({ user: makeUser({ newCardStyle: "reveal" }) });
    let view = await openTest(fixture, [1]);
    // "Снова" keeps the card in the session for `MAX_REQUEUES` more rounds —
    // the introduction must not have eaten one of them.
    let ratings = 0;
    for (let guard = 0; guard <= MAX_REQUEUES + 2; guard += 1) {
      const result = await fixture.service.rate({
        user: fixture.user,
        session: view.session,
        position: view.position,
        rating: 1,
        now: NOW,
      });
      if (result.kind !== "card") {
        ratings += 1;
        expect(result.kind).toBe("summary");
        break;
      }
      ratings += 1;
      view = result;
    }
    expect(ratings).toBe(MAX_REQUEUES + 1);
    expect(fixture.fake.state.logs).toHaveLength(MAX_REQUEUES + 1);
  });
});

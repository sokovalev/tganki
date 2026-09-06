import { describe, expect, it } from "vitest";
import { createLimits, FREE_LIMITS, isPro } from "../src/services/limits.js";
import { makeUser } from "./helpers/fakeSession.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");

function limits(
  counts: { decks: number; notes: number; generations?: number; extractions?: number },
  proEnabled: boolean,
  onCount?: (since: Date) => void,
) {
  return createLimits(
    {
      countOwnDecks: async () => counts.decks,
      countOwnNotes: async () => counts.notes,
      countGenerationsSince: async (_userId, since) => {
        onCount?.(since);
        return counts.generations ?? 0;
      },
      countExtractionsSince: async (_userId, since) => {
        onCount?.(since);
        return counts.extractions ?? 0;
      },
    },
    { proEnabled },
  );
}

describe("isPro", () => {
  it("treats free as free and honours plan_until", () => {
    expect(isPro(makeUser(), NOW)).toBe(false);
    expect(isPro(makeUser({ plan: "pro", planUntil: null }), NOW)).toBe(true);
    expect(
      isPro(makeUser({ plan: "pro", planUntil: new Date("2026-01-11T00:00:00.000Z") }), NOW),
    ).toBe(true);
    expect(
      isPro(makeUser({ plan: "pro", planUntil: new Date("2026-01-09T00:00:00.000Z") }), NOW),
    ).toBe(false);
    expect(isPro(makeUser({ plan: "lifetime", planUntil: null }), NOW)).toBe(true);
  });
});

describe("free-plan limits", () => {
  const user = makeUser();

  it("allows everything when PRO_ENABLED is off, without touching the database", async () => {
    let queried = false;
    const gate = createLimits(
      {
        countOwnDecks: async () => {
          queried = true;
          return 999;
        },
        countOwnNotes: async () => {
          queried = true;
          return 999;
        },
        countGenerationsSince: async () => {
          queried = true;
          return 999;
        },
        countExtractionsSince: async () => {
          queried = true;
          return 999;
        },
      },
      { proEnabled: false },
    );
    expect(await gate.canCreateDeck(user, NOW)).toMatchObject({ allowed: true });
    expect(await gate.canAddNotes(user, 50, NOW)).toMatchObject({ allowed: true });
    expect(await gate.canGenerate(user, NOW)).toMatchObject({ allowed: true });
    expect(queried).toBe(false);
  });

  it("caps own decks at the free budget", async () => {
    const gate = limits({ decks: FREE_LIMITS.ownDecks - 1, notes: 0 }, true);
    expect(await gate.canCreateDeck(user, NOW)).toMatchObject({
      allowed: true,
      limit: FREE_LIMITS.ownDecks,
      used: FREE_LIMITS.ownDecks - 1,
    });
    const full = limits({ decks: FREE_LIMITS.ownDecks, notes: 0 }, true);
    expect(await full.canCreateDeck(user, NOW)).toMatchObject({ allowed: false });
  });

  it("counts the whole batch against the note budget", async () => {
    const gate = limits({ decks: 0, notes: FREE_LIMITS.ownNotes - 2 }, true);
    expect(await gate.canAddNotes(user, 2, NOW)).toMatchObject({ allowed: true });
    expect(await gate.canAddNotes(user, 3, NOW)).toMatchObject({ allowed: false });
  });

  it("caps AI generations per learning day", async () => {
    const left = limits(
      { decks: 0, notes: 0, generations: FREE_LIMITS.generationsPerDay - 1 },
      true,
    );
    expect(await left.canGenerate(user, NOW)).toMatchObject({
      allowed: true,
      limit: FREE_LIMITS.generationsPerDay,
      used: FREE_LIMITS.generationsPerDay - 1,
    });
    const spent = limits({ decks: 0, notes: 0, generations: FREE_LIMITS.generationsPerDay }, true);
    expect(await spent.canGenerate(user, NOW)).toMatchObject({ allowed: false });
  });

  it("counts generations from the 04:00 boundary of the user's day", async () => {
    let since: Date | null = null;
    const gate = limits({ decks: 0, notes: 0, generations: 0 }, true, (at) => {
      since = at;
    });
    // 15:00 Moscow on 2026-01-10 → the day started at 04:00 local (01:00 UTC).
    await gate.canGenerate(user, NOW);
    expect(since).toEqual(new Date("2026-01-10T01:00:00.000Z"));
  });

  it("does not gate Pro users", async () => {
    const pro = makeUser({ plan: "pro", planUntil: null });
    const gate = limits({ decks: 100, notes: 10_000, generations: 1_000 }, true);
    expect(await gate.canCreateDeck(pro, NOW)).toMatchObject({ allowed: true });
    expect(await gate.canAddNotes(pro, 500, NOW)).toMatchObject({ allowed: true });
    expect(await gate.canGenerate(pro, NOW)).toMatchObject({ allowed: true });
  });
});

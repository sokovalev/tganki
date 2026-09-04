import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../src/db/schema.js";
import { startReminderCron } from "../src/reminders/cron.js";
import {
  candidateLocalTimes,
  createReminderService,
  isReminderDue,
  localHhMm,
  type ReminderPort,
  type ReminderSender,
  type SendOutcome,
} from "../src/services/reminderService.js";
import { makeUser } from "./helpers/fakeSession.js";

/** 12:00 UTC = 15:00 in Moscow, 07:00 in New York. */
const NOW = new Date("2026-01-10T12:00:00.000Z");

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof createReminderService>[2]["logger"];

describe("timezone maths", () => {
  it("reads local time from IANA zones and fixed offsets alike", () => {
    expect(localHhMm(NOW, "Europe/Moscow")).toBe("15:00");
    expect(localHhMm(NOW, "+03:00")).toBe("15:00");
    expect(localHhMm(NOW, "-05:00")).toBe("07:00");
    expect(localHhMm(NOW, "not-a-zone")).toBe("12:00");
  });

  it("offers every local time some zone could be showing", () => {
    const times = candidateLocalTimes(NOW);
    expect(times).toContain("15:00");
    expect(times).toContain("07:00");
    expect(times).toContain("17:45");
    expect(times.length).toBeLessThan(120);
  });
});

describe("isReminderDue", () => {
  const base = makeUser({ reminderTime: "15:00", tz: "Europe/Moscow" });

  it("fires at the user's local reminder minute", () => {
    expect(isReminderDue(base, NOW)).toBe(true);
    expect(isReminderDue({ ...base, tz: "-05:00" }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, tz: "-05:00", reminderTime: "07:00" }, NOW)).toBe(true);
  });

  it("skips users with reminders off, blocked users and unfinished onboarding", () => {
    expect(isReminderDue({ ...base, reminderTime: null }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, blockedAt: NOW }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, onboardingStep: "tz" }, NOW)).toBe(false);
  });

  it("skips users who already got a reminder today", () => {
    expect(isReminderDue({ ...base, lastRemindedDay: "2026-01-10" }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, lastRemindedDay: "2026-01-09" }, NOW)).toBe(true);
  });

  it("skips users who already studied today", () => {
    expect(isReminderDue({ ...base, streakLastDay: "2026-01-10" }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, streakLastDay: "2026-01-09" }, NOW)).toBe(true);
  });

  it("uses the 04:00 learning day, so a 02:00 reminder still counts as yesterday", () => {
    const night = new Date("2026-01-10T23:30:00.000Z"); // 02:30 MSK on the 11th
    const user = makeUser({ reminderTime: "02:30", tz: "Europe/Moscow" });
    expect(isReminderDue({ ...user, lastRemindedDay: "2026-01-10" }, night)).toBe(false);
    expect(isReminderDue({ ...user, lastRemindedDay: "2026-01-09" }, night)).toBe(true);
  });
});

interface FakeReminders {
  port: ReminderPort;
  sender: ReminderSender;
  sent: number[];
  reminded: Array<{ userId: number; day: string }>;
  blocked: number[];
  counters: Map<number, { due: number; newAvailable: number }>;
  outcome: SendOutcome;
}

function fakeReminders(users: User[]): FakeReminders {
  const state: FakeReminders = {
    sent: [],
    reminded: [],
    blocked: [],
    counters: new Map(),
    outcome: "sent",
    port: {
      async listCandidates(times) {
        return users.filter(
          (user) => user.reminderTime !== null && times.includes(user.reminderTime),
        );
      },
      async counters({ userId }) {
        return state.counters.get(userId) ?? { due: 5, newAvailable: 3 };
      },
      async markReminded(userId, day) {
        state.reminded.push({ userId, day });
      },
      async markBlocked(userId) {
        state.blocked.push(userId);
      },
    },
    sender: {
      async send(user) {
        state.sent.push(user.id);
        return state.outcome;
      },
    },
  };
  return state;
}

describe("reminder service", () => {
  it("sends only to the users whose minute it is", async () => {
    const fake = fakeReminders([
      makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" }),
      makeUser({ id: 2, reminderTime: "15:00", tz: "-05:00" }),
      makeUser({ id: 3, reminderTime: "07:00", tz: "-05:00" }),
    ]);
    const service = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
    });
    const stats = await service.run(NOW);
    expect(fake.sent).toEqual([1, 3]);
    expect(stats).toMatchObject({ eligible: 2, sent: 2, blocked: 0 });
    expect(fake.reminded).toEqual([
      { userId: 1, day: "2026-01-10" },
      { userId: 3, day: "2026-01-10" },
    ]);
  });

  it("stays quiet when there is nothing to study", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.counters.set(1, { due: 0, newAvailable: 0 });
    const service = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
    });
    const stats = await service.run(NOW);
    expect(fake.sent).toEqual([]);
    expect(stats.skipped).toBe(1);
    // Still recorded, so we do not re-check the same user every minute.
    expect(fake.reminded).toHaveLength(1);
  });

  it("marks users who blocked the bot and stops reminding them", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.outcome = "blocked";
    const service = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
    });
    const stats = await service.run(NOW);
    expect(fake.blocked).toEqual([1]);
    expect(fake.reminded).toEqual([]);
    expect(stats.blocked).toBe(1);
  });

  it("does not mark a transient failure as delivered", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.outcome = "failed";
    const service = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
    });
    const stats = await service.run(NOW);
    expect(stats.failed).toBe(1);
    expect(fake.reminded).toEqual([]);
    expect(fake.blocked).toEqual([]);
  });

  it("throttles between messages", async () => {
    const users = [1, 2, 3].map((id) =>
      makeUser({ id, reminderTime: "15:00", tz: "Europe/Moscow" }),
    );
    const fake = fakeReminders(users);
    const waits: number[] = [];
    const service = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      perSecond: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await service.run(NOW);
    // No wait before the first message, 40 ms before each of the others.
    expect(waits).toEqual([40, 40]);
  });
});

describe("reminder cron", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const emptyStats = {
    checked: 0,
    eligible: 0,
    sent: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
  };

  it("ticks once a minute", async () => {
    let runs = 0;
    const cron = startReminderCron({
      run: async () => {
        runs += 1;
        return emptyStats;
      },
      logger: silentLogger,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(3);
    cron.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(3);
  });

  it("never overlaps two runs", async () => {
    let active = 0;
    let overlaps = 0;
    let finished = 0;
    const cron = startReminderCron({
      run: async () => {
        active += 1;
        if (active > 1) overlaps += 1;
        await new Promise((resolve) => setTimeout(resolve, 150_000));
        active -= 1;
        finished += 1;
        return emptyStats;
      },
      logger: silentLogger,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(600_000);
    cron.stop();
    expect(overlaps).toBe(0);
    expect(finished).toBeGreaterThan(0);
  });

  it("survives a failing tick", async () => {
    let runs = 0;
    const cron = startReminderCron({
      run: async () => {
        runs += 1;
        throw new Error("database is on fire");
      },
      logger: silentLogger,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(180_000);
    cron.stop();
    expect(runs).toBe(3);
  });
});

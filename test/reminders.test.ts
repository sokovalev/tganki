import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeeklyReport } from "../src/db/repos/stats.js";
import type { User } from "../src/db/schema.js";
import { createI18n, translator } from "../src/i18n/index.js";
import { startReminderCron } from "../src/reminders/cron.js";
import { renderMessage } from "../src/reminders/render.js";
import {
  candidateDayKeys,
  candidateLocalTimes,
  createReminderService,
  hoursUntilDayEnd,
  isoWeekKey,
  isReminderDue,
  isStreakNudgeDue,
  isWeeklyReportDue,
  localHhMm,
  minutesUntil,
  type ReminderMessage,
  type ReminderPort,
  type ReminderSender,
  type SendOutcome,
  weeklyWindow,
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
  sent: Array<{ userId: number; message: ReminderMessage }>;
  reminded: Array<{ userId: number; day: string }>;
  nudged: Array<{ userId: number; day: string }>;
  reported: Array<{ userId: number; week: string }>;
  events: Array<{ userId: number; name: string; props: Record<string, unknown> }>;
  blocked: number[];
  counters: Map<number, { due: number; newAvailable: number }>;
  weekly: Map<number, WeeklyReport>;
  outcome: SendOutcome;
}

const emptyWeek: WeeklyReport = {
  reviews: 0,
  correct: 0,
  newCards: 0,
  learned: 0,
  daysStudied: 0,
  prevReviews: 0,
  forecast: 0,
  hardest: [],
};

/** Only the daily reminder narrows by "HH:MM"; the other two jobs filter in JS. */
function fakeReminders(users: User[]): FakeReminders {
  const state: FakeReminders = {
    sent: [],
    reminded: [],
    nudged: [],
    reported: [],
    events: [],
    blocked: [],
    counters: new Map(),
    weekly: new Map(),
    outcome: "sent",
    port: {
      async listCandidates(times) {
        return users.filter(
          (user) => user.reminderTime !== null && times.includes(user.reminderTime),
        );
      },
      async listStreakNudgeCandidates({ minStreak }) {
        return users.filter((user) => user.streakNudge && user.streak >= minStreak);
      },
      async listWeeklyReportCandidates() {
        return users;
      },
      async counters({ userId }) {
        return state.counters.get(userId) ?? { due: 5, newAvailable: 3 };
      },
      async weekly({ userId }) {
        return state.weekly.get(userId) ?? emptyWeek;
      },
      async markReminded(userId, day) {
        state.reminded.push({ userId, day });
      },
      async markStreakNudged(userId, day) {
        state.nudged.push({ userId, day });
      },
      async markWeeklyReported(userId, week) {
        state.reported.push({ userId, week });
      },
      async markBlocked(userId) {
        state.blocked.push(userId);
      },
      record(userId, name, props) {
        state.events.push({ userId, name, props });
      },
    },
    sender: {
      async send(user, message) {
        state.sent.push({ userId: user.id, message });
        return state.outcome;
      },
    },
  };
  return state;
}

/** The user ids the fake sender was handed, in order. */
function sentIds(fake: FakeReminders): number[] {
  return fake.sent.map((entry) => entry.userId);
}

function service(fake: FakeReminders, sleep?: (ms: number) => Promise<void>) {
  return createReminderService(fake.port, fake.sender, {
    logger: silentLogger,
    sleep: sleep ?? (async () => {}),
  });
}

describe("the hourly Pro expiry step (SPEC §9.2)", () => {
  /** Ticks the cron with an `expirePro` hook that only counts its calls. */
  function hourly(fake: FakeReminders) {
    const calls: Date[] = [];
    const runner = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
      expirePro: async (at) => {
        calls.push(at);
        return 2;
      },
    });
    return { runner, calls };
  }

  it("runs on the first tick and then once per wall-clock hour", async () => {
    const { runner, calls } = hourly(fakeReminders([]));
    const first = await runner.run(NOW);
    expect(calls).toHaveLength(1);
    expect(first.expired).toBe(2);
    // Same hour, next minute: nothing to do.
    const again = await runner.run(new Date("2026-01-10T12:30:00.000Z"));
    expect(calls).toHaveLength(1);
    expect(again.expired).toBe(0);
    // The hour rolls over.
    await runner.run(new Date("2026-01-10T13:00:00.000Z"));
    expect(calls).toHaveLength(2);
  });

  it("still sends the reminders when the sweep throws", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    const runner = createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      sleep: async () => {},
      expirePro: async () => {
        throw new Error("database is down");
      },
    });
    const stats = await runner.run(NOW);
    expect(stats.expired).toBe(0);
    expect(sentIds(fake)).toEqual([1]);
  });

  it("does nothing at all when no hook is wired in", async () => {
    const fake = fakeReminders([]);
    expect((await service(fake).run(NOW)).expired).toBe(0);
  });
});

describe("reminder service", () => {
  it("sends only to the users whose minute it is", async () => {
    const fake = fakeReminders([
      makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" }),
      makeUser({ id: 2, reminderTime: "15:00", tz: "-05:00" }),
      makeUser({ id: 3, reminderTime: "07:00", tz: "-05:00" }),
    ]);
    const stats = await service(fake).run(NOW);
    expect(sentIds(fake)).toEqual([1, 3]);
    expect(stats).toMatchObject({ eligible: 2, sent: 2, blocked: 0 });
    expect(fake.reminded).toEqual([
      { userId: 1, day: "2026-01-10" },
      { userId: 3, day: "2026-01-10" },
    ]);
  });

  it("stays quiet when there is nothing to study", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.counters.set(1, { due: 0, newAvailable: 0 });
    const stats = await service(fake).run(NOW);
    expect(fake.sent).toEqual([]);
    expect(stats.skipped).toBe(1);
    // Still recorded, so we do not re-check the same user every minute.
    expect(fake.reminded).toHaveLength(1);
  });

  it("marks users who blocked the bot and stops reminding them", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.outcome = "blocked";
    const stats = await service(fake).run(NOW);
    expect(fake.blocked).toEqual([1]);
    expect(fake.reminded).toEqual([]);
    expect(stats.blocked).toBe(1);
  });

  it("does not mark a transient failure as delivered", async () => {
    const fake = fakeReminders([makeUser({ id: 1, reminderTime: "15:00", tz: "Europe/Moscow" })]);
    fake.outcome = "failed";
    const stats = await service(fake).run(NOW);
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
    await createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      perSecond: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).run(NOW);
    // No wait before the first message, 40 ms before each of the others.
    expect(waits).toEqual([40, 40]);
  });
});

/** 18:00 UTC = 21:00 in Moscow — the streak-nudge minute (SPEC §6.2). */
const NUDGE = new Date("2026-01-10T18:00:00.000Z");
/** 07:00 UTC on Monday 7 Sep = 10:00 in Moscow — the weekly-report minute (§6.3). */
const MONDAY = new Date("2026-09-07T07:00:00.000Z");

describe("isStreakNudgeDue", () => {
  const base = makeUser({
    reminderTime: "08:00",
    tz: "Europe/Moscow",
    streak: 7,
    streakLastDay: "2026-01-09",
  });

  it("fires at 21:00 local in an IANA zone and in a fixed offset alike", () => {
    expect(isStreakNudgeDue(base, NUDGE)).toBe(true);
    expect(isStreakNudgeDue({ ...base, tz: "+03:00" }, NUDGE)).toBe(true);
    expect(isStreakNudgeDue({ ...base, tz: "-05:00" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue(base, NOW)).toBe(false);
  });

  it("needs a streak worth defending", () => {
    expect(isStreakNudgeDue({ ...base, streak: 3 }, NUDGE)).toBe(true);
    expect(isStreakNudgeDue({ ...base, streak: 2 }, NUDGE)).toBe(false);
  });

  it("respects the reminder switch, the nudge toggle, blocks and onboarding", () => {
    expect(isStreakNudgeDue({ ...base, reminderTime: null }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, streakNudge: false }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, blockedAt: NUDGE }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, onboardingStep: "tz" }, NUDGE)).toBe(false);
  });

  it("skips users who already studied or were already nudged today", () => {
    expect(isStreakNudgeDue({ ...base, streakLastDay: "2026-01-10" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, lastStreakNudgeDay: "2026-01-10" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, lastStreakNudgeDay: "2026-01-09" }, NUDGE)).toBe(true);
  });

  it("stays quiet when the daily reminder is due within three hours", () => {
    expect(isStreakNudgeDue({ ...base, reminderTime: "21:00" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, reminderTime: "22:00" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, reminderTime: "23:59" }, NUDGE)).toBe(false);
    expect(isStreakNudgeDue({ ...base, reminderTime: "00:30" }, NUDGE)).toBe(true);
    expect(isStreakNudgeDue({ ...base, reminderTime: "20:00" }, NUDGE)).toBe(true);
  });

  it("measures the wait to the next occurrence of a local time", () => {
    expect(minutesUntil("21:00", "22:00")).toBe(60);
    expect(minutesUntil("21:00", "00:00")).toBe(180);
    expect(minutesUntil("21:00", "20:00")).toBe(1380);
    expect(minutesUntil("21:00", "21:00")).toBe(0);
  });

  it("counts the hours left until the 04:00 boundary", () => {
    expect(hoursUntilDayEnd(NUDGE, "Europe/Moscow")).toBe(7);
    expect(hoursUntilDayEnd(NUDGE, "+03:00")).toBe(7);
    // 02:00 MSK on the 11th is still the learning day that started on the 10th.
    const night = new Date("2026-01-10T23:00:00.000Z");
    expect(hoursUntilDayEnd(night, "Europe/Moscow")).toBe(2);
    expect(hoursUntilDayEnd(new Date("2026-01-11T00:59:00.000Z"), "Europe/Moscow")).toBe(1);
  });

  it("knows which learning days and ISO weeks are current somewhere", () => {
    expect(candidateDayKeys(NUDGE)).toEqual(["2026-01-10", "2026-01-11"]);
    expect(isoWeekKey("2026-09-07")).toBe("2026-W37");
    expect(isoWeekKey("2026-08-31")).toBe("2026-W36");
  });
});

describe("streak nudge delivery", () => {
  const endangered = (overrides: Partial<User> = {}): User =>
    makeUser({
      id: 1,
      reminderTime: "08:00",
      tz: "Europe/Moscow",
      streak: 7,
      streakLastDay: "2026-01-09",
      ...overrides,
    });

  it("nudges once, marks the day and records the event", async () => {
    const fake = fakeReminders([endangered()]);
    const stats = await service(fake).run(NUDGE);
    expect(stats).toMatchObject({ eligible: 1, sent: 1, nudged: 1 });
    expect(fake.sent[0]?.message).toEqual({
      kind: "streak_nudge",
      streak: 7,
      hours: 7,
      freeze: true,
    });
    expect(fake.nudged).toEqual([{ userId: 1, day: "2026-01-10" }]);
    expect(fake.events).toEqual([{ userId: 1, name: "streak_nudge_sent", props: { streak: 7 } }]);
  });

  it("does not repeat itself on the next tick of the same day", async () => {
    const fake = fakeReminders([endangered({ lastStreakNudgeDay: "2026-01-10" })]);
    const stats = await service(fake).run(NUDGE);
    expect(fake.sent).toEqual([]);
    expect(stats.eligible).toBe(0);
  });

  it("says the freeze is gone once it has been spent this week", async () => {
    const fake = fakeReminders([endangered({ streakFreezeDay: "2026-01-08" })]);
    await service(fake).run(NUDGE);
    expect(fake.sent[0]?.message).toMatchObject({ freeze: false });
  });

  it("marks a user who blocked the bot and writes no marker", async () => {
    const fake = fakeReminders([endangered()]);
    fake.outcome = "blocked";
    const stats = await service(fake).run(NUDGE);
    expect(fake.blocked).toEqual([1]);
    expect(fake.nudged).toEqual([]);
    expect(stats).toMatchObject({ blocked: 1, nudged: 0 });
  });

  it("shares one throttle with the daily reminder", async () => {
    const fake = fakeReminders([
      makeUser({ id: 1, reminderTime: "21:00", tz: "Europe/Moscow", streakLastDay: "2026-01-09" }),
      endangered({ id: 2 }),
    ]);
    const waits: number[] = [];
    await createReminderService(fake.port, fake.sender, {
      logger: silentLogger,
      perSecond: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).run(NUDGE);
    // User 1 gets the daily reminder, user 2 the nudge, 40 ms apart.
    expect(sentIds(fake)).toEqual([1, 2]);
    expect(waits).toEqual([40]);
  });
});

describe("isWeeklyReportDue", () => {
  const base = makeUser({
    reminderTime: "08:00",
    tz: "Europe/Moscow",
    streakLastDay: "2026-09-05",
  });

  it("fires on Monday 10:00 local, in an IANA zone and a fixed offset alike", () => {
    expect(isWeeklyReportDue(base, MONDAY)).toBe(true);
    expect(isWeeklyReportDue({ ...base, tz: "+03:00" }, MONDAY)).toBe(true);
    expect(isWeeklyReportDue({ ...base, tz: "-05:00" }, MONDAY)).toBe(false);
    // Same minute, but a Sunday.
    expect(isWeeklyReportDue(base, new Date("2026-09-06T07:00:00.000Z"))).toBe(false);
    expect(isWeeklyReportDue(base, new Date("2026-09-07T08:00:00.000Z"))).toBe(false);
  });

  it("runs once per ISO week", () => {
    expect(isWeeklyReportDue({ ...base, lastWeeklyReportWeek: "2026-W37" }, MONDAY)).toBe(false);
    expect(isWeeklyReportDue({ ...base, lastWeeklyReportWeek: "2026-W36" }, MONDAY)).toBe(true);
  });

  it("skips users who have not reviewed anything in two weeks", () => {
    expect(isWeeklyReportDue({ ...base, streakLastDay: "2026-08-24" }, MONDAY)).toBe(true);
    expect(isWeeklyReportDue({ ...base, streakLastDay: "2026-08-23" }, MONDAY)).toBe(false);
    expect(isWeeklyReportDue({ ...base, streakLastDay: null }, MONDAY)).toBe(false);
  });

  it("follows the reminder switch and skips blocked users", () => {
    expect(isWeeklyReportDue({ ...base, reminderTime: null }, MONDAY)).toBe(false);
    expect(isWeeklyReportDue({ ...base, blockedAt: MONDAY }, MONDAY)).toBe(false);
    expect(isWeeklyReportDue({ ...base, onboardingStep: "tz" }, MONDAY)).toBe(false);
  });

  it("reports the week that just ended, Monday to Sunday", () => {
    const window = weeklyWindow(MONDAY, "Europe/Moscow");
    expect(window.from).toBe("2026-08-31");
    expect(window.to).toBe("2026-09-06");
    expect(window.week).toBe("2026-W37");
    expect(window.weekStart.toISOString()).toBe("2026-08-31T01:00:00.000Z");
    expect(window.weekEnd.toISOString()).toBe("2026-09-07T01:00:00.000Z");
    expect(window.prevStart.toISOString()).toBe("2026-08-24T01:00:00.000Z");
    expect(window.forecastEnd.toISOString()).toBe("2026-09-14T01:00:00.000Z");
    expect(weeklyWindow(MONDAY, "+03:00")).toEqual(window);
  });
});

describe("weekly report delivery", () => {
  const reader = (overrides: Partial<User> = {}): User =>
    makeUser({
      id: 1,
      reminderTime: "08:00",
      tz: "Europe/Moscow",
      streak: 9,
      streakLastDay: "2026-09-05",
      ...overrides,
    });

  it("sends the week's numbers, marks the week and records the event", async () => {
    const fake = fakeReminders([reader()]);
    fake.weekly.set(1, {
      reviews: 214,
      correct: 184,
      newCards: 38,
      learned: 12,
      daysStudied: 5,
      prevReviews: 190,
      forecast: 120,
      hardest: ["reluctant", "ყველი", "der Tisch"],
    });
    const stats = await service(fake).run(MONDAY);
    expect(stats).toMatchObject({ eligible: 1, sent: 1, reported: 1 });
    expect(fake.sent[0]?.message).toMatchObject({
      kind: "weekly_report",
      from: "2026-08-31",
      to: "2026-09-06",
      reviews: 214,
      streak: 9,
      idle: false,
    });
    expect(fake.reported).toEqual([{ userId: 1, week: "2026-W37" }]);
    expect(fake.events).toEqual([
      { userId: 1, name: "weekly_report_sent", props: { reviews: 214, newCards: 38 } },
    ]);
  });

  it("sends the short «no study» variant after a quiet week", async () => {
    const fake = fakeReminders([reader()]);
    fake.weekly.set(1, { ...emptyWeek, prevReviews: 40, forecast: 12 });
    const stats = await service(fake).run(MONDAY);
    expect(fake.sent[0]?.message).toMatchObject({ kind: "weekly_report", idle: true, streak: 9 });
    expect(stats).toMatchObject({ sent: 1, reported: 1 });
  });

  it("says nothing at all when the week before was empty too", async () => {
    const fake = fakeReminders([reader()]);
    const stats = await service(fake).run(MONDAY);
    expect(fake.sent).toEqual([]);
    expect(stats.skipped).toBe(1);
    // Marked anyway, so the query does not re-run every minute of the hour.
    expect(fake.reported).toEqual([{ userId: 1, week: "2026-W37" }]);
  });

  it("does not repeat itself inside the same ISO week", async () => {
    const fake = fakeReminders([reader({ lastWeeklyReportWeek: "2026-W37" })]);
    fake.weekly.set(1, { ...emptyWeek, reviews: 10, correct: 9, prevReviews: 3 });
    await service(fake).run(MONDAY);
    expect(fake.sent).toEqual([]);
    expect(fake.reported).toEqual([]);
  });
});

describe("reminder messages", () => {
  const i18n = createI18n();

  it("writes the streak nudge in both languages", () => {
    const nudge = (locale: "ru" | "en", freeze: boolean) =>
      renderMessage(translator(i18n, locale), locale, {
        kind: "streak_nudge",
        streak: 7,
        hours: 7,
        freeze,
      }).text;
    expect(nudge("ru", false)).toBe(
      "🔥 Стрик 7 дней сгорит через 7 часов. Сегодня ещё ни одной карточки. Хватит и пяти минут.",
    );
    expect(nudge("ru", true)).toContain("Заморозка спасёт стрик один раз, но лучше не тратить.");
    expect(nudge("en", false)).toBe(
      "🔥 Your 7-day streak burns out in 7 hours. Not a single card today. Five minutes is enough.",
    );
    expect(nudge("en", true)).toContain("A freeze would save it once");
  });

  it("lays the weekly report out as SPEC §6.3 draws it", () => {
    const text = renderMessage(translator(i18n, "ru"), "ru", {
      kind: "weekly_report",
      from: "2026-08-31",
      to: "2026-09-06",
      reviews: 214,
      correct: 184,
      newCards: 38,
      learned: 12,
      daysStudied: 5,
      streak: 9,
      hardest: ["reluctant", "ყველი", "der Tisch"],
      forecast: 120,
      idle: false,
    }).text;
    expect(text.split("\n")).toEqual([
      "📈 Неделя 31 авг – 6 сент",
      "Повторений: 214 · Точность: 86 %",
      "Новых слов: 38 · Выучено (стабильность ≥ 21 д): 12",
      "Дней с занятиями: 5 из 7 · 🔥 Стрик: 9",
      "Самые трудные: reluctant, ყველი, der Tisch",
      "Ближайшая неделя: ~120 повторений",
    ]);
  });

  it("shortens the report to a nudge when the week was empty", () => {
    const text = renderMessage(translator(i18n, "ru"), "ru", {
      kind: "weekly_report",
      from: "2026-08-31",
      to: "2026-09-06",
      reviews: 0,
      correct: 0,
      newCards: 0,
      learned: 0,
      daysStudied: 0,
      streak: 9,
      hardest: [],
      forecast: 40,
      idle: true,
    }).text;
    expect(text).toBe(
      "📈 Неделя 31 авг – 6 сент\nНа этой неделе не было занятий. 🔥 Стрик: 9 дней — вернись, пока он держится.",
    );
  });

  it("escapes the hardest words, which come from user notes", () => {
    const text = renderMessage(translator(i18n, "en"), "en", {
      kind: "weekly_report",
      from: "2026-08-31",
      to: "2026-09-06",
      reviews: 3,
      correct: 3,
      newCards: 0,
      learned: 0,
      daysStudied: 1,
      streak: 1,
      hardest: ["<b>bold</b>"],
      forecast: 1,
      idle: false,
    }).text;
    expect(text).toContain("Hardest: &lt;b&gt;bold&lt;/b&gt;");
  });
});

describe("reminder cron", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const emptyStats = {
    checked: 0,
    eligible: 0,
    nudged: 0,
    reported: 0,
    sent: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
    expired: 0,
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

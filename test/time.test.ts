import { describe, expect, it } from "vitest";
import {
  formatOffset,
  normalizeReminderTime,
  offsetFromLocalTime,
  parseHhMm,
} from "../src/bot/time.js";

const NOON_UTC = new Date("2026-01-10T12:00:00.000Z");

describe("parseHhMm", () => {
  it("accepts the formats people actually type", () => {
    expect(parseHhMm("21:15")).toEqual({ hours: 21, minutes: 15 });
    expect(parseHhMm(" 9.05 ")).toEqual({ hours: 9, minutes: 5 });
    expect(parseHhMm("2115")).toEqual({ hours: 21, minutes: 15 });
    expect(parseHhMm("905")).toEqual({ hours: 9, minutes: 5 });
    expect(parseHhMm("21")).toEqual({ hours: 21, minutes: 0 });
  });

  it("rejects nonsense", () => {
    expect(parseHhMm("25:00")).toBeNull();
    expect(parseHhMm("12:75")).toBeNull();
    expect(parseHhMm("вечером")).toBeNull();
  });
});

describe("offsetFromLocalTime", () => {
  it("derives the offset from the reported local time", () => {
    expect(offsetFromLocalTime(NOON_UTC, "15:00")).toBe("+03:00");
    expect(offsetFromLocalTime(NOON_UTC, "12:00")).toBe("+00:00");
    expect(offsetFromLocalTime(NOON_UTC, "07:00")).toBe("-05:00");
  });

  it("rounds to half an hour", () => {
    expect(offsetFromLocalTime(NOON_UTC, "15:12")).toBe("+03:00");
    expect(offsetFromLocalTime(NOON_UTC, "15:20")).toBe("+03:30");
    expect(offsetFromLocalTime(NOON_UTC, "17:40")).toBe("+05:30");
    // Exactly halfway between two steps rounds up.
    expect(offsetFromLocalTime(NOON_UTC, "17:45")).toBe("+06:00");
  });

  it("wraps across midnight instead of inventing +19:00", () => {
    const lateUtc = new Date("2026-01-10T23:00:00.000Z");
    expect(offsetFromLocalTime(lateUtc, "02:00")).toBe("+03:00");
    const earlyUtc = new Date("2026-01-10T01:00:00.000Z");
    expect(offsetFromLocalTime(earlyUtc, "20:00")).toBe("-05:00");
  });

  it("returns null when the time is unreadable", () => {
    expect(offsetFromLocalTime(NOON_UTC, "около трёх")).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formats offsets with a sign and two-digit parts", () => {
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(330)).toBe("+05:30");
    expect(formatOffset(-210)).toBe("-03:30");
  });

  it("normalizes reminder times coming from compact callback data", () => {
    expect(normalizeReminderTime("0800")).toBe("08:00");
    expect(normalizeReminderTime("2000")).toBe("20:00");
    expect(normalizeReminderTime("off")).toBeNull();
  });
});

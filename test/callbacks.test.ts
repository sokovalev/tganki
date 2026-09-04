import { describe, expect, it } from "vitest";
import {
  argInt,
  argStr,
  callbackByteLength,
  encodeCallback,
  MAX_CALLBACK_BYTES,
  matches,
  parseCallback,
} from "../src/bot/callbacks.js";

describe("encodeCallback", () => {
  it("joins namespace, action and arguments", () => {
    expect(encodeCallback("r", "3", 2)).toBe("r:3:2");
    expect(encodeCallback("d", "v", 17)).toBe("d:v:17");
  });

  it("drops trailing empty parts so bare namespaces stay short", () => {
    expect(encodeCallback("m")).toBe("m");
    expect(encodeCallback("d", "")).toBe("d");
  });

  it("refuses separators inside a part", () => {
    expect(() => encodeCallback("o", "rem", "08:00")).toThrow(/must not contain/u);
  });

  it("refuses payloads Telegram would reject", () => {
    expect(() => encodeCallback("d", "v", "x".repeat(MAX_CALLBACK_BYTES))).toThrow(/too long/u);
  });

  it("counts bytes, not characters", () => {
    expect(callbackByteLength("привет")).toBe(12);
  });
});

describe("parseCallback", () => {
  it("splits into namespace, action and args", () => {
    expect(parseCallback("s:skip:4")).toEqual({ ns: "s", action: "skip", args: ["4"] });
    expect(parseCallback("r:0:1")).toEqual({ ns: "r", action: "0", args: ["1"] });
  });

  it("handles a bare namespace", () => {
    expect(parseCallback("m")).toEqual({ ns: "m", action: "", args: [] });
  });

  it("rejects empty and oversized data", () => {
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback("")).toBeNull();
    expect(parseCallback(":x")).toBeNull();
    expect(parseCallback("d:v:".padEnd(MAX_CALLBACK_BYTES + 1, "9"))).toBeNull();
  });

  it("round-trips everything the bot builds", () => {
    for (const data of ["m", "l", "l:d:12", "s:show:7", "r:7:4", "c:open:7", "set:ret:95"]) {
      const parsed = parseCallback(data);
      expect(parsed).not.toBeNull();
      expect(encodeCallback(parsed!.ns, parsed!.action, ...parsed!.args)).toBe(data);
    }
  });
});

describe("argument accessors", () => {
  const parsed = parseCallback("d:npd:12:20")!;

  it("reads integers and strings by position", () => {
    expect(argInt(parsed, 0)).toBe(12);
    expect(argInt(parsed, 1)).toBe(20);
    expect(argStr(parsed, 1)).toBe("20");
    expect(argInt(parsed, 2)).toBeNull();
  });

  it("returns null for non-numeric arguments", () => {
    expect(argInt(parseCallback("d:npd:12:d")!, 1)).toBeNull();
  });

  it("matches namespace and action", () => {
    expect(matches(parsed, "d")).toBe(true);
    expect(matches(parsed, "d", "npd")).toBe(true);
    expect(matches(parsed, "d", "v")).toBe(false);
    expect(matches(null, "d")).toBe(false);
  });
});

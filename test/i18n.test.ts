import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandList } from "../src/bot/commands.js";
import { RATING_KEYS } from "../src/bot/format.js";
import { createI18n, LOCALES_DIR, SUPPORTED_LOCALES, translator } from "../src/i18n/index.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** Every message in a Fluent file with the variables its value references. */
function messageVars(locale: string): Map<string, string[]> {
  const source = readFileSync(path.join(LOCALES_DIR, `${locale}.ftl`), "utf8");
  const messages = new Map<string, string[]>();
  let current: string | null = null;
  let body = "";
  const flush = () => {
    if (current === null) return;
    messages.set(current, [...new Set([...body.matchAll(/\$(\w+)/gu)].map((m) => m[1]!))]);
  };
  for (const line of source.split("\n")) {
    const match = /^([a-zA-Z][\w-]*)\s*=(.*)$/u.exec(line);
    if (match) {
      flush();
      current = match[1]!;
      body = match[2] ?? "";
      continue;
    }
    if (current !== null && (line.startsWith(" ") || line.trim() === "")) body += `\n${line}`;
    else {
      flush();
      current = null;
    }
  }
  flush();
  return messages;
}

function messageIds(locale: string): Set<string> {
  return new Set(messageVars(locale).keys());
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Every `t("...")` literal in the source tree. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([a-z][a-z0-9-]*)"/gu)) {
      keys.add(match[1]!);
    }
  }
  for (const key of Object.values(RATING_KEYS)) keys.add(key);
  return keys;
}

describe("locales", () => {
  const i18n = createI18n();

  it("loads every supported locale", () => {
    expect(i18n.locales.sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("declares the same message ids in every locale", () => {
    const ru = messageIds("ru");
    const en = messageIds("en");
    expect([...ru].filter((key) => !en.has(key))).toEqual([]);
    expect([...en].filter((key) => !ru.has(key))).toEqual([]);
  });

  it("actually registers every declared message (Fluent drops junk silently)", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = translator(i18n, locale);
      for (const [key, vars] of messageVars(locale)) {
        const args = Object.fromEntries(vars.map((name) => [name, 1]));
        const rendered = t(key, args);
        expect(rendered, `${locale}: ${key}`).not.toBe(`{${key}}`);
        expect(rendered, `${locale}: ${key}`).not.toContain("{$");
      }
    }
  });

  it("defines every key the code asks for", () => {
    const ru = messageIds("ru");
    const missing = [...usedKeys()].filter((key) => !ru.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("resolves without leaving placeholders or bidi isolates", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = translator(i18n, locale);
      const rendered = t("menu-today", { due: 12, new: 10 });
      expect(rendered).not.toContain("{");
      expect(rendered).not.toContain("⁨");
    }
  });

  it("pluralizes Russian correctly", () => {
    const t = translator(i18n, "ru");
    expect(t("summary-streak", { n: 1 })).toContain("1 день");
    expect(t("summary-streak", { n: 3 })).toContain("3 дня");
    expect(t("summary-streak", { n: 8 })).toContain("8 дней");
    expect(t("summary-streak", { n: 21 })).toContain("21 день");
  });

  it("pluralizes English correctly", () => {
    const t = translator(i18n, "en");
    expect(t("summary-streak", { n: 1 })).toContain("1 day");
    expect(t("summary-streak", { n: 8 })).toContain("8 days");
  });

  it("has a description for every registered command in both locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const command of commandList(i18n, locale)) {
        expect(command.description).not.toContain("{");
        expect(command.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to Russian for an unknown locale", () => {
    expect(translator(i18n, "fr")("btn-menu")).toBe(translator(i18n, "ru")("btn-menu"));
  });
});

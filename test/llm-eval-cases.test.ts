import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_CATEGORIES, type EvalCase, parseCases } from "../scripts/llm-eval/types.js";

const CASES_PATH = join(process.cwd(), "scripts/llm-eval/cases.json");
const cases: EvalCase[] = parseCases(JSON.parse(readFileSync(CASES_PATH, "utf8")));

const MKHEDRULI = /^[ა-ჿ]+$/u;

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

describe("cases.json", () => {
  it("holds 120 cases with unique ids", () => {
    expect(cases).toHaveLength(120);
    expect(new Set(cases.map((item) => item.id)).size).toBe(120);
  });

  it("has the 20/20/20/60 language distribution and always translates into ru", () => {
    expect(countBy(cases, (item) => item.langFrom)).toEqual({ en: 20, de: 20, es: 20, ka: 60 });
    expect(cases.every((item) => item.langTo === "ru")).toBe(true);
  });

  it("uses only known categories and covers all the tricky ones", () => {
    const used = new Set(cases.map((item) => item.category));
    for (const category of used) expect(CASE_CATEGORIES).toContain(category);
    for (const required of [
      "polysemous",
      "multiword",
      "article",
      "inflected",
      "typo",
      "reverse",
      "translit",
      "postposition",
      "number",
      "junk",
    ]) {
      expect(used).toContain(required);
    }
  });

  it("has exactly four junk cases and none of them carries expectations", () => {
    const junk = cases.filter((item) => item.category === "junk");
    expect(junk).toHaveLength(4);
    for (const item of junk) expect(item.expect?.detectedLang).toBeUndefined();
  });

  it("writes every Georgian expected front in Mkhedruli", () => {
    const ka = cases.filter((item) => item.langFrom === "ka" && item.expect?.front !== undefined);
    expect(ka.length).toBeGreaterThan(40);
    for (const item of ka) {
      // Postpositions keep their leading hyphen, phrases their spaces.
      const letters = (item.expect?.front ?? "").replace(/[-\s]/gu, "");
      expect(MKHEDRULI.test(letters), `${item.id}: ${item.expect?.front}`).toBe(true);
    }
  });

  it("expects the Georgian masdar for every conjugated Georgian verb", () => {
    const conjugated = cases.filter(
      (item) => item.langFrom === "ka" && item.category === "inflected",
    );
    expect(conjugated.length).toBeGreaterThanOrEqual(6);
    for (const item of conjugated) {
      expect(item.expect?.front, item.id).toBeDefined();
      expect(item.text).not.toBe(item.expect?.front);
    }
  });

  it("covers reverse input (native language typed) for every language", () => {
    const reverse = cases.filter((item) => item.category === "reverse");
    expect(new Set(reverse.map((item) => item.langFrom))).toEqual(
      new Set(["en", "de", "es", "ka"]),
    );
    for (const item of reverse) expect(item.expect?.detectedLang).toBe("ru");
  });

  it("expects Latin transliteration of Georgian to be detected as ka", () => {
    const translit = cases.filter((item) => item.category === "translit");
    expect(translit.length).toBeGreaterThanOrEqual(3);
    for (const item of translit) {
      expect(item.expect?.detectedLang).toBe("ka");
      expect(/^[\x20-\x7e]+$/u.test(item.text), item.id).toBe(true);
    }
  });

  it("gives German and Spanish nouns an article in the expected front", () => {
    const articles = cases.filter(
      (item) => item.category === "article" && item.expect?.pos === "noun",
    );
    expect(articles.length).toBeGreaterThanOrEqual(8);
    for (const item of articles) {
      expect(item.expect?.front ?? "", item.id).toMatch(/^(der|die|das|el|la|los|las) /u);
    }
  });
});

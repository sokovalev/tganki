/**
 * Deterministic checks over one generated card. Pure functions only — every
 * one of them is unit-tested in `test/llm-eval-checks.test.ts`.
 *
 * A check that does not apply to a case (no expectation, junk input) is simply
 * not returned, so the pass rate is always "passed / applicable".
 */

import type { GeneratedCard } from "../../src/llm/types.js";
import { ALLOWED_POS, KA_IPA_CHARS } from "./prompt.js";
import type { CheckResult, EvalCase } from "./types.js";

const GEORGIAN_LETTER = /[ა-ჺ]/u;
const GEORGIAN_ONLY = /^[Ⴀ-ჿ\s-]+$/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{M}\s'’-]+$/u;
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const CYRILLIC_ONLY = /^[\p{Script=Cyrillic}\p{M}\s'’-]+$/u;
const BRACKETS = /[/\\[\](){}⟨⟩]/u;

/** Articles are dropped before asking "does the example use this word?". */
const ARTICLES = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "the",
  "to",
]);

export function normalizeForCompare(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Russian comparison ignores the ё/е spelling split. */
export function normalizeRu(value: string): string {
  return normalizeForCompare(value).replace(/ё/gu, "е");
}

export type ScriptName = "georgian" | "latin" | "cyrillic";

export function scriptFor(lang: string): ScriptName {
  if (lang === "ka") return "georgian";
  if (lang === "ru" || lang === "uk" || lang === "bg") return "cyrillic";
  return "latin";
}

/** True when `text` is written wholly in the script `lang` uses. */
export function isInScript(text: string, lang: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  switch (scriptFor(lang)) {
    case "georgian":
      return GEORGIAN_ONLY.test(trimmed) && GEORGIAN_LETTER.test(trimmed);
    case "cyrillic":
      return CYRILLIC_ONLY.test(trimmed) && CYRILLIC_LETTER.test(trimmed);
    default:
      return LATIN_ONLY.test(trimmed) && LATIN_LETTER.test(trimmed);
  }
}

/** ≥ 60% of the letters are Cyrillic (proper names in Latin are tolerated). */
export function isMostlyCyrillic(text: string): boolean {
  let cyrillic = 0;
  let latin = 0;
  for (const char of text) {
    if (CYRILLIC_LETTER.test(char)) cyrillic += 1;
    else if (LATIN_LETTER.test(char)) latin += 1;
  }
  if (cyrillic === 0) return false;
  return cyrillic / (cyrillic + latin) >= 0.6;
}

export function transcriptionIssue(transcription: string, langFrom: string): string | null {
  if (BRACKETS.test(transcription)) return `contains slashes/brackets: ${transcription}`;
  if (langFrom !== "ka") return null;
  if (transcription.trim() === "") return "empty Georgian transcription";
  const bad = [...transcription].filter((char) => !KA_IPA_CHARS.has(char));
  if (bad.length > 0) return `not in the ka IPA table: ${[...new Set(bad)].join("")}`;
  return null;
}

function tokenize(value: string): string[] {
  return normalizeForCompare(value)
    .split(/[\s.,!?;:"«»]+/u)
    .map((token) => token.replace(/^[-–—]+|[-–—]+$/gu, ""))
    .filter((token) => token.length > 0);
}

/**
 * "The example actually uses the word": the example contains the front form, or
 * a form sharing its first three letters (which covers Georgian preverbs and
 * person markers, German separable prefixes and Spanish conjugation).
 */
export function exampleUsesFront(front: string, example: string): boolean {
  const exampleTokens = tokenize(example);
  if (exampleTokens.length === 0) return false;
  const normalizedExample = normalizeForCompare(example);
  const all = tokenize(front);
  const content = all.filter((token) => !ARTICLES.has(token));
  const tokens = content.length > 0 ? content : all;
  if (tokens.length === 0) return false;
  return tokens.some((token) => {
    if (normalizedExample.includes(token)) return true;
    if (token.length < 3) return false;
    const prefix = token.slice(0, 3);
    return exampleTokens.some((word) => word.includes(prefix));
  });
}

export function backIncludesAny(back: string, needles: readonly string[]): boolean {
  const haystack = normalizeRu(back);
  return needles.some((needle) => haystack.includes(normalizeRu(needle)));
}

function check(name: string, pass: boolean, detail?: string): CheckResult {
  return detail === undefined || pass ? { name, pass } : { name, pass, detail };
}

/**
 * All applicable checks for one call. `card` is null when the reply could not
 * be parsed or validated; then only the schema check is reported.
 */
export function runChecks(
  evalCase: EvalCase,
  card: GeneratedCard | null,
  error?: string | null,
): CheckResult[] {
  const schema = check("schema", card !== null, error ?? "no card");
  if (card === null) return [schema];
  // Junk inputs are only expected to produce a schema-valid object.
  if (evalCase.category === "junk") return [schema];

  const results: CheckResult[] = [schema];
  const expected = evalCase.expect;

  results.push(
    check(
      "front_script",
      isInScript(card.front, evalCase.langFrom),
      `front "${card.front}" is not ${scriptFor(evalCase.langFrom)} script for langFrom=${evalCase.langFrom}`,
    ),
  );

  if (expected?.detectedLang !== undefined) {
    results.push(
      check(
        "detected_lang",
        card.detectedLang.toLowerCase() === expected.detectedLang.toLowerCase(),
        `got "${card.detectedLang}", expected "${expected.detectedLang}"`,
      ),
    );
  }

  if (expected?.front !== undefined) {
    results.push(
      check(
        "front",
        normalizeForCompare(card.front) === normalizeForCompare(expected.front),
        `got "${card.front}", expected "${expected.front}"`,
      ),
    );
  }

  results.push(
    check(
      "pos",
      (ALLOWED_POS as readonly string[]).includes(card.pos.trim().toLowerCase()),
      `"${card.pos}" is not one of ${ALLOWED_POS.join(", ")}`,
    ),
  );

  if (expected?.pos !== undefined) {
    results.push(
      check(
        "pos_expected",
        card.pos.trim().toLowerCase() === expected.pos.trim().toLowerCase(),
        `got "${card.pos}", expected "${expected.pos}"`,
      ),
    );
  }

  if (expected?.backIncludesAny !== undefined) {
    results.push(
      check(
        "back",
        backIncludesAny(card.back, expected.backIncludesAny),
        `"${card.back}" contains none of: ${expected.backIncludesAny.join(", ")}`,
      ),
    );
  }

  const transcription = transcriptionIssue(card.transcription, evalCase.langFrom);
  results.push(check("transcription", transcription === null, transcription ?? undefined));

  results.push(
    check(
      "example_uses_front",
      exampleUsesFront(card.front, card.example),
      `example "${card.example}" does not use "${card.front}"`,
    ),
  );

  results.push(
    check(
      "example_tr_cyrillic",
      isMostlyCyrillic(card.exampleTr),
      `exampleTr is not Cyrillic: "${card.exampleTr}"`,
    ),
  );

  return results;
}

export function passRate(checks: readonly CheckResult[]): number {
  if (checks.length === 0) return 0;
  return checks.filter((item) => item.pass).length / checks.length;
}

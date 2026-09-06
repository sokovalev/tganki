/**
 * Everything the judge needs that is pure: its system prompt, the JSON schema
 * of its reply, the deterministic blinding shuffle and the message builder.
 * Kept apart from `judge.ts` so the tests can import it without running a CLI.
 */

import { z } from "zod";
import type { JsonSchema } from "./prompt.js";
import type { CallRecord, EvalCase } from "./types.js";

export const JUDGE_SYSTEM_PROMPT = `You grade flashcards produced by different systems for a Russian-speaking learner. You are given one input word and several candidate cards labelled A, B, C… You do not know which system produced which card, and you must not guess or mention it.

Score EVERY label on four criteria, each an integer 1-5:
- translation: is "back" the right set of meanings for the input, in Russian, 1-3 senses, no clutter? 5 = exactly what a good dictionary would give, 1 = wrong word.
- canonical: is "front" the canonical dictionary form in the language being learned? German nouns need their article ("der Tisch"), Spanish nouns their article ("la mesa"), Georgian verbs the masdar ("კითხვა", never "ვკითხულობ"), English phrasal verbs their particle. A card whose front is in the learner's native language scores 1. "pos" and "detectedLang" being wrong also cost points here.
- example: is the example sentence grammatical, natural, short, at A1-A2 level, does it really use the word, and is exampleTr a faithful Russian translation?
- transcription: is the IPA correct for the front form? For Georgian it must mark aspiration with ʰ (თ=tʰ, ფ=pʰ, ქ=kʰ, ჩ=t͡ʃʰ, ც=t͡sʰ) and ejectives with ʼ (კ=kʼ, პ=pʼ, ტ=tʼ, წ=t͡sʼ, ჭ=t͡ʃʼ, ყ=qʼ), use ɑ ɛ ɔ for ა ე ო, and carry no slashes or brackets. An empty transcription where one is expected scores 1.

Also give a one-line "issue" per label: the single worst problem with that card, or "ok" when there is none. Russian or English, under 15 words.

Be strict and consistent: identical cards must get identical scores. Judge only what you were shown.`;

export const JUDGE_SCHEMA_NAME = "card_scores";

export const JUDGE_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      description: "One entry per label, in label order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "translation", "canonical", "example", "transcription", "issue"],
        properties: {
          label: { type: "string", description: "A, B, C…" },
          translation: { type: "integer", description: "1-5" },
          canonical: { type: "integer", description: "1-5" },
          example: { type: "integer", description: "1-5" },
          transcription: { type: "integer", description: "1-5" },
          issue: { type: "string", description: "One line, or 'ok'." },
        },
      },
    },
  },
};

export const judgeReplySchema = z.object({
  scores: z.array(
    z.object({
      label: z.string(),
      translation: z.number(),
      canonical: z.number(),
      example: z.number(),
      transcription: z.number(),
      issue: z.string(),
    }),
  ),
});

/** 32-bit FNV-1a — a stable seed per case id. */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-case shuffle so a resumed run blinds identically. */
export function shuffleDeterministic<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const random = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

export function labelFor(index: number): string {
  return String.fromCharCode(65 + index);
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, Math.round(value)));
}

/** The judge's user turn: the case, its expectations, and the labelled cards. */
export function buildJudgeMessage(
  evalCase: EvalCase,
  labelled: readonly { label: string; record: CallRecord }[],
): string {
  const expectations: string[] = [];
  const expected = evalCase.expect;
  if (expected?.detectedLang) expectations.push(`the user typed ${expected.detectedLang}`);
  if (expected?.front) expectations.push(`canonical form should be "${expected.front}"`);
  if (expected?.pos) expectations.push(`part of speech should be ${expected.pos}`);
  if (expected?.backIncludesAny) {
    expectations.push(`meaning should include one of: ${expected.backIncludesAny.join(", ")}`);
  }
  const lines = [
    `Input: "${evalCase.text}"`,
    `Language being learned: ${evalCase.langFrom}. Learner's native language: ${evalCase.langTo}.`,
    evalCase.category === "junk"
      ? "This input is NOT a real word (emoji, random letters, a URL or a whole sentence). A good card refuses gracefully instead of inventing a translation; score an invented translation low."
      : expectations.length > 0
        ? `Reference expectations (a good card matches these): ${expectations.join("; ")}.`
        : "No reference expectations for this input.",
    evalCase.note && evalCase.category !== "junk" ? `Note: ${evalCase.note}` : "",
    "",
    "Candidates:",
  ].filter((line) => line !== "");
  for (const { label, record } of labelled) {
    const card = record.card;
    if (!card) continue;
    lines.push(
      `${label})` +
        ` front="${card.front}"` +
        ` | back="${card.back}"` +
        ` | transcription="${card.transcription}"` +
        ` | example="${card.example}"` +
        ` | exampleTr="${card.exampleTr}"` +
        ` | pos="${card.pos}"` +
        ` | detectedLang="${card.detectedLang}"`,
    );
  }
  lines.push("", `Score all ${labelled.length} labels.`);
  return lines.join("\n");
}

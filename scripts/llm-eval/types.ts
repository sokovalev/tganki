/** Shared shapes for the evaluation harness: cases, per-call records, judge output. */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { GeneratedCard } from "../../src/llm/types.js";

export const CASE_CATEGORIES = [
  "plain",
  "polysemous",
  "multiword",
  "article",
  "inflected",
  "typo",
  "reverse",
  "translit",
  "phrase",
  "postposition",
  "number",
  "junk",
] as const;

export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  langFrom: z.string().min(2),
  langTo: z.string().min(2),
  category: z.enum(CASE_CATEGORIES),
  expect: z
    .object({
      detectedLang: z.string().min(2).optional(),
      front: z.string().min(1).optional(),
      pos: z.string().min(1).optional(),
      backIncludesAny: z.array(z.string().min(1)).min(1).optional(),
    })
    .optional(),
  note: z.string().optional(),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalCasesSchema = z.array(evalCaseSchema);

export function parseCases(json: unknown): EvalCase[] {
  const cases = evalCasesSchema.parse(json);
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    seen.add(item.id);
  }
  return cases;
}

export function loadCases(path: string): EvalCase[] {
  return parseCases(JSON.parse(readFileSync(path, "utf8")));
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD, as reported by OpenRouter (`usage.cost`). */
  costUsd: number;
}

export type ResponseMode = "json_schema" | "json_object";

/** One model × case × repeat call. */
export interface CallRecord {
  caseId: string;
  model: string;
  repeat: number;
  langFrom: string;
  category: CaseCategory;
  /** Raw assistant text, kept so a human can inspect what the model actually said. */
  raw: string;
  card: GeneratedCard | null;
  error: string | null;
  latencyMs: number;
  usage: UsageRecord;
  mode: ResponseMode | null;
  checks: CheckResult[];
}

export interface ModelRunFile {
  runId: string;
  model: string;
  createdAt: string;
  records: CallRecord[];
}

export interface JudgeScore {
  caseId: string;
  model: string;
  label: string;
  /** 1-5 each. */
  translation: number;
  canonical: number;
  example: number;
  transcription: number;
  issue: string;
}

export interface JudgeFile {
  runId: string;
  judgeModel: string;
  createdAt: string;
  totalCostUsd: number;
  /** caseId -> label -> model. Kept for auditing the blinding. */
  assignments: Record<string, Record<string, string>>;
  scores: JudgeScore[];
  errors: { caseId: string; message: string }[];
}

export const JUDGE_CRITERIA = ["translation", "canonical", "example", "transcription"] as const;

export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

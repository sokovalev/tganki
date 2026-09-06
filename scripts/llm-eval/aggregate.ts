/**
 * Pure aggregation over the raw run files: no IO, no console, no dates.
 * `report.ts` only reads files and prints what this module returns.
 */

import { passRate } from "./checks.js";
import {
  type CallRecord,
  JUDGE_CRITERIA,
  type JudgeFile,
  type JudgeScore,
  type ModelRunFile,
} from "./types.js";

export interface JudgeAverages {
  n: number;
  translation: number;
  canonical: number;
  example: number;
  transcription: number;
  /** Sum of the four means, so 20 is a perfect card. */
  total: number;
}

export interface LangStats {
  lang: string;
  calls: number;
  schemaValidRate: number;
  checkPassRate: number;
  judge: JudgeAverages | null;
}

export interface ModelStats {
  model: string;
  calls: number;
  errors: number;
  schemaValidRate: number;
  checkPassRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  /** Extrapolated from the measured `usage.cost`. Null when nothing was billed. */
  costPer1000Usd: number | null;
  promptTokens: number;
  completionTokens: number;
  modes: Record<string, number>;
  judge: JudgeAverages | null;
  byLang: Record<string, LangStats>;
}

export interface Aggregation {
  runId: string;
  languages: string[];
  models: ModelStats[];
  judgeModel: string | null;
  judgeCostUsd: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageJudge(scores: readonly JudgeScore[]): JudgeAverages | null {
  if (scores.length === 0) return null;
  const per = Object.fromEntries(
    JUDGE_CRITERIA.map((criterion) => [criterion, mean(scores.map((score) => score[criterion]))]),
  ) as Record<(typeof JUDGE_CRITERIA)[number], number>;
  return {
    n: scores.length,
    translation: per.translation,
    canonical: per.canonical,
    example: per.example,
    transcription: per.transcription,
    total: JUDGE_CRITERIA.reduce((sum, criterion) => sum + per[criterion], 0),
  };
}

function statsFor(records: readonly CallRecord[], scores: readonly JudgeScore[]): LangStats {
  const valid = records.filter((record) => record.card !== null).length;
  const checks = records.flatMap((record) => record.checks);
  return {
    lang: records[0]?.langFrom ?? "",
    calls: records.length,
    schemaValidRate: records.length === 0 ? 0 : valid / records.length,
    checkPassRate: passRate(checks),
    judge: averageJudge(scores),
  };
}

/** Folds every model file (plus the optional judge file) into per-model stats. */
export function aggregate(runs: readonly ModelRunFile[], judge?: JudgeFile | null): Aggregation {
  const caseLang = new Map<string, string>();
  for (const run of runs) {
    for (const record of run.records) caseLang.set(record.caseId, record.langFrom);
  }
  const languages = [...new Set([...caseLang.values()])].sort();
  const scoresByModel = new Map<string, JudgeScore[]>();
  for (const score of judge?.scores ?? []) {
    const list = scoresByModel.get(score.model) ?? [];
    list.push(score);
    scoresByModel.set(score.model, list);
  }

  const models = runs
    .map((run): ModelStats => {
      const records = run.records;
      const scores = scoresByModel.get(run.model) ?? [];
      const overall = statsFor(records, scores);
      const byLang: Record<string, LangStats> = {};
      for (const lang of languages) {
        const langRecords = records.filter((record) => record.langFrom === lang);
        const langScores = scores.filter((score) => caseLang.get(score.caseId) === lang);
        if (langRecords.length > 0) byLang[lang] = statsFor(langRecords, langScores);
      }
      const latencies = records.filter((r) => r.error === null).map((r) => r.latencyMs);
      const totalCostUsd = records.reduce((sum, record) => sum + record.usage.costUsd, 0);
      const modes: Record<string, number> = {};
      for (const record of records) {
        if (record.mode === null) continue;
        modes[record.mode] = (modes[record.mode] ?? 0) + 1;
      }
      return {
        model: run.model,
        calls: records.length,
        errors: records.filter((record) => record.error !== null).length,
        schemaValidRate: overall.schemaValidRate,
        checkPassRate: overall.checkPassRate,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        totalCostUsd,
        costPer1000Usd:
          records.length === 0 || totalCostUsd === 0
            ? null
            : (totalCostUsd / records.length) * 1000,
        promptTokens: records.reduce((sum, record) => sum + record.usage.promptTokens, 0),
        completionTokens: records.reduce((sum, record) => sum + record.usage.completionTokens, 0),
        modes,
        judge: overall.judge,
        byLang,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));

  return {
    runId: runs[0]?.runId ?? judge?.runId ?? "",
    languages,
    models,
    judgeModel: judge?.judgeModel ?? null,
    judgeCostUsd: judge?.totalCostUsd ?? 0,
  };
}

export interface DecisionCandidate {
  model: string;
  georgianTotal: number;
  costPer1000Usd: number | null;
}

export interface Decision {
  /** Cheapest model that is schema-perfect and near the best Georgian score. */
  winner: string | null;
  best: DecisionCandidate | null;
  /** 95% of the best Georgian judge total. */
  threshold: number;
  candidates: DecisionCandidate[];
  eligible: DecisionCandidate[];
  reason: string;
}

export const GEORGIAN_TOLERANCE = 0.95;

/**
 * The rule the harness exists to apply: among models with 100% schema
 * validity, take the cheapest one whose Georgian judge total is within 5% of
 * the best Georgian total.
 */
export function decide(aggregation: Aggregation): Decision {
  const candidates: DecisionCandidate[] = aggregation.models
    .filter((model) => model.calls > 0 && model.schemaValidRate === 1)
    .map((model) => ({
      model: model.model,
      georgianTotal: model.byLang.ka?.judge?.total ?? 0,
      costPer1000Usd: model.costPer1000Usd,
    }));
  if (candidates.length === 0) {
    return {
      winner: null,
      best: null,
      threshold: 0,
      candidates,
      eligible: [],
      reason: "no model returned a schema-valid card for every case",
    };
  }
  const best = candidates.reduce((a, b) => (b.georgianTotal > a.georgianTotal ? b : a));
  if (best.georgianTotal === 0) {
    return {
      winner: null,
      best,
      threshold: 0,
      candidates,
      eligible: candidates,
      reason: "no Georgian judge scores yet — run `pnpm eval:judge` first",
    };
  }
  const threshold = best.georgianTotal * GEORGIAN_TOLERANCE;
  const eligible = candidates
    .filter((candidate) => candidate.georgianTotal >= threshold)
    .sort(
      (a, b) =>
        (a.costPer1000Usd ?? Number.POSITIVE_INFINITY) -
          (b.costPer1000Usd ?? Number.POSITIVE_INFINITY) || b.georgianTotal - a.georgianTotal,
    );
  const winner = eligible[0] ?? null;
  return {
    winner: winner?.model ?? null,
    best,
    threshold,
    candidates,
    eligible,
    reason:
      winner === null
        ? "no schema-perfect model reached 95% of the best Georgian score"
        : `${winner.model} is the cheapest schema-perfect model within 5% of the best Georgian total (${best.model}, ${best.georgianTotal.toFixed(2)}/20)`,
  };
}

export interface GeorgianSample {
  caseId: string;
  /** What the user typed, so a native reviewer can judge the card. */
  text: string;
  front: string;
  back: string;
  example: string;
  exampleTr: string;
  total: number;
  issue: string;
}

/** The `limit` worst-judged Georgian cards for one model — for a native check. */
export function lowestGeorgian(
  runs: readonly ModelRunFile[],
  judge: JudgeFile | null,
  model: string,
  limit = 10,
  inputs: ReadonlyMap<string, string> = new Map(),
): GeorgianSample[] {
  const run = runs.find((item) => item.model === model);
  if (!run || !judge) return [];
  const byCase = new Map(run.records.filter((r) => r.repeat === 0).map((r) => [r.caseId, r]));
  return judge.scores
    .filter((score) => score.model === model)
    .map((score) => ({ score, record: byCase.get(score.caseId) }))
    .filter(
      (entry): entry is { score: JudgeScore; record: CallRecord } =>
        entry.record !== undefined && entry.record.langFrom === "ka" && entry.record.card !== null,
    )
    .map(({ score, record }) => ({
      caseId: score.caseId,
      text: inputs.get(score.caseId) ?? "",
      front: record.card?.front ?? "",
      back: record.card?.back ?? "",
      example: record.card?.example ?? "",
      exampleTr: record.card?.exampleTr ?? "",
      total: JUDGE_CRITERIA.reduce((sum, criterion) => sum + score[criterion], 0),
      issue: score.issue,
    }))
    .sort((a, b) => a.total - b.total || a.caseId.localeCompare(b.caseId))
    .slice(0, limit);
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(4)}`);
const num = (value: number | undefined): string => (value === undefined ? "—" : value.toFixed(2));

/** Markdown table cells must not contain a raw pipe or newline. */
const cell = (value: string): string => value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

/** The whole REPORT.md, as a string. */
export function renderMarkdown(
  aggregation: Aggregation,
  decision: Decision,
  samples: readonly { model: string; rows: readonly GeorgianSample[] }[],
): string {
  const out: string[] = [];
  out.push(`# LLM card-generation eval — run \`${aggregation.runId}\``);
  out.push("");
  out.push(
    `Judge: ${aggregation.judgeModel ?? "not run"}${
      aggregation.judgeCostUsd > 0 ? ` (${usd(aggregation.judgeCostUsd)})` : ""
    }`,
  );
  out.push("");
  out.push("## Decision");
  out.push("");
  out.push(
    decision.winner === null
      ? `**No pick.** ${decision.reason}`
      : `**Pick: \`${decision.winner}\`** — ${decision.reason}`,
  );
  out.push("");
  out.push(
    `Rule: among models with 100% schema validity, the cheapest one whose Georgian judge total is ≥ 95% of the best Georgian total (threshold ${decision.threshold.toFixed(2)}/20).`,
  );
  out.push("");
  if (decision.candidates.length > 0) {
    out.push(
      table(
        ["model", "ka judge total", "≥ threshold", "$/1000 cards"],
        decision.candidates
          .slice()
          .sort((a, b) => b.georgianTotal - a.georgianTotal)
          .map((candidate) => [
            `\`${candidate.model}\``,
            candidate.georgianTotal.toFixed(2),
            candidate.georgianTotal >= decision.threshold ? "yes" : "no",
            usd(candidate.costPer1000Usd),
          ]),
      ),
    );
    out.push("");
  }

  out.push("## Overall");
  out.push("");
  out.push(
    table(
      [
        "model",
        "schema valid",
        "auto checks",
        "judge total",
        "p50 ms",
        "p95 ms",
        "total $",
        "$/1000 cards",
      ],
      aggregation.models.map((model) => [
        `\`${model.model}\``,
        pct(model.schemaValidRate),
        pct(model.checkPassRate),
        model.judge === null ? "—" : `${model.judge.total.toFixed(2)}/20`,
        String(Math.round(model.p50LatencyMs)),
        String(Math.round(model.p95LatencyMs)),
        usd(model.totalCostUsd),
        usd(model.costPer1000Usd),
      ]),
    ),
  );
  out.push("");

  out.push("## Judge criteria (mean of 1–5)");
  out.push("");
  out.push(
    table(
      ["model", "translation", "canonical", "example", "transcription", "total", "n"],
      aggregation.models.map((model) => [
        `\`${model.model}\``,
        num(model.judge?.translation),
        num(model.judge?.canonical),
        num(model.judge?.example),
        num(model.judge?.transcription),
        model.judge === null ? "—" : `${model.judge.total.toFixed(2)}/20`,
        String(model.judge?.n ?? 0),
      ]),
    ),
  );
  out.push("");

  for (const lang of aggregation.languages) {
    out.push(`## Language: ${lang}`);
    out.push("");
    out.push(
      table(
        ["model", "calls", "schema valid", "auto checks", "judge total"],
        aggregation.models.map((model) => {
          const stats = model.byLang[lang];
          return [
            `\`${model.model}\``,
            String(stats?.calls ?? 0),
            stats === undefined ? "—" : pct(stats.schemaValidRate),
            stats === undefined ? "—" : pct(stats.checkPassRate),
            stats?.judge === undefined || stats.judge === null
              ? "—"
              : `${stats.judge.total.toFixed(2)}/20`,
          ];
        }),
      ),
    );
    out.push("");
  }

  if (samples.length > 0) {
    out.push("## Weakest Georgian cards (native check needed)");
    out.push("");
    for (const sample of samples) {
      out.push(`### \`${sample.model}\``);
      out.push("");
      if (sample.rows.length === 0) {
        out.push("No judged Georgian cards.");
      } else {
        out.push(
          table(
            ["case", "input", "front", "back", "example", "exampleTr", "judge", "issue"],
            sample.rows.map((row) => [
              row.caseId,
              cell(row.text),
              cell(row.front),
              cell(row.back),
              cell(row.example),
              cell(row.exampleTr),
              `${row.total}/20`,
              cell(row.issue),
            ]),
          ),
        );
      }
      out.push("");
    }
  }
  return `${out.join("\n")}\n`;
}

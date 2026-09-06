import { describe, expect, it } from "vitest";
import {
  aggregate,
  decide,
  GEORGIAN_TOLERANCE,
  lowestGeorgian,
  percentile,
  renderMarkdown,
} from "../scripts/llm-eval/aggregate.js";
import {
  buildJudgeMessage,
  clampScore,
  hashSeed,
  labelFor,
  shuffleDeterministic,
} from "../scripts/llm-eval/judgePrompt.js";
import type {
  CallRecord,
  CheckResult,
  EvalCase,
  JudgeFile,
  JudgeScore,
  ModelRunFile,
} from "../scripts/llm-eval/types.js";
import type { GeneratedCard } from "../src/llm/types.js";

const card: GeneratedCard = {
  front: "სახლი",
  back: "дом",
  transcription: "sɑxli",
  example: "ჩემი სახლი დიდია.",
  exampleTr: "Мой дом большой.",
  pos: "noun",
  detectedLang: "ka",
};

function record(
  overrides: Partial<CallRecord> & Pick<CallRecord, "caseId" | "model" | "langFrom">,
): CallRecord {
  const checks: CheckResult[] = overrides.checks ?? [
    { name: "schema", pass: true },
    { name: "front", pass: true },
  ];
  return {
    repeat: 0,
    category: "plain",
    raw: JSON.stringify(card),
    card,
    error: null,
    latencyMs: 1000,
    usage: { promptTokens: 740, completionTokens: 130, totalTokens: 870, costUsd: 0.001 },
    mode: "json_schema",
    ...overrides,
    checks,
  };
}

function runFile(model: string, records: CallRecord[]): ModelRunFile {
  return { runId: "r1", model, createdAt: "2026-09-06T00:00:00.000Z", records };
}

function score(caseId: string, model: string, value: number, issue = "ok"): JudgeScore {
  return {
    caseId,
    model,
    label: "A",
    translation: value,
    canonical: value,
    example: value,
    transcription: value,
    issue,
  };
}

describe("percentile", () => {
  it("picks the nearest-rank value", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.5)).toBe(7);
  });
});

describe("aggregate", () => {
  const runs = [
    runFile("cheap/model", [
      record({ caseId: "ka-1", model: "cheap/model", langFrom: "ka", latencyMs: 500 }),
      record({ caseId: "en-1", model: "cheap/model", langFrom: "en", latencyMs: 900 }),
    ]),
    runFile("dear/model", [
      record({
        caseId: "ka-1",
        model: "dear/model",
        langFrom: "ka",
        latencyMs: 3000,
        usage: { promptTokens: 740, completionTokens: 130, totalTokens: 870, costUsd: 0.02 },
      }),
      record({
        caseId: "en-1",
        model: "dear/model",
        langFrom: "en",
        card: null,
        error: "invalid_output: not JSON",
        checks: [{ name: "schema", pass: false }],
        usage: { promptTokens: 740, completionTokens: 0, totalTokens: 740, costUsd: 0.02 },
      }),
    ]),
  ];
  const judge: JudgeFile = {
    runId: "r1",
    judgeModel: "judge/model",
    createdAt: "2026-09-06T00:00:00.000Z",
    totalCostUsd: 0.5,
    assignments: { "ka-1": { A: "cheap/model", B: "dear/model" } },
    scores: [
      score("ka-1", "cheap/model", 4),
      score("ka-1", "dear/model", 5),
      score("en-1", "cheap/model", 3),
    ],
    errors: [],
  };

  it("computes per-model and per-language rates", () => {
    const result = aggregate(runs, judge);
    expect(result.languages).toEqual(["en", "ka"]);
    const cheap = result.models.find((model) => model.model === "cheap/model");
    const dear = result.models.find((model) => model.model === "dear/model");
    expect(cheap?.schemaValidRate).toBe(1);
    expect(cheap?.checkPassRate).toBe(1);
    expect(dear?.schemaValidRate).toBe(0.5);
    expect(dear?.checkPassRate).toBeCloseTo(2 / 3);
    expect(cheap?.byLang.ka?.judge?.total).toBe(16);
    expect(cheap?.byLang.en?.judge?.total).toBe(12);
    expect(dear?.byLang.ka?.judge?.total).toBe(20);
  });

  it("extrapolates cost per 1000 cards and p50/p95 latency", () => {
    const result = aggregate(runs, judge);
    const cheap = result.models.find((model) => model.model === "cheap/model");
    expect(cheap?.totalCostUsd).toBeCloseTo(0.002);
    expect(cheap?.costPer1000Usd).toBeCloseTo(1);
    expect(cheap?.p50LatencyMs).toBe(500);
    expect(cheap?.p95LatencyMs).toBe(900);
    const dear = result.models.find((model) => model.model === "dear/model");
    // Only successful calls count towards latency.
    expect(dear?.p50LatencyMs).toBe(3000);
    expect(dear?.costPer1000Usd).toBeCloseTo(20);
  });

  it("reports null cost when nothing was billed", () => {
    const free = aggregate([
      runFile("free/model", [
        record({
          caseId: "ka-1",
          model: "free/model",
          langFrom: "ka",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 },
        }),
      ]),
    ]);
    expect(free.models[0]?.costPer1000Usd).toBeNull();
  });

  it("survives having no judge file", () => {
    const result = aggregate(runs, null);
    expect(result.judgeModel).toBeNull();
    expect(result.models[0]?.judge).toBeNull();
  });
});

describe("decide", () => {
  function make(
    entries: readonly { model: string; ka: number; cost: number; schemaValid?: boolean }[],
  ) {
    const files = entries.map((entry) =>
      runFile(entry.model, [
        record({
          caseId: "ka-1",
          model: entry.model,
          langFrom: "ka",
          card: entry.schemaValid === false ? null : card,
          error: entry.schemaValid === false ? "boom" : null,
          checks: [{ name: "schema", pass: entry.schemaValid !== false }],
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            costUsd: entry.cost / 1000,
          },
        }),
      ]),
    );
    const judge: JudgeFile = {
      runId: "r1",
      judgeModel: "judge/model",
      createdAt: "2026-09-06T00:00:00.000Z",
      totalCostUsd: 0,
      assignments: {},
      scores: entries.map((entry) => score("ka-1", entry.model, entry.ka / 4)),
      errors: [],
    };
    return decide(aggregate(files, judge));
  }

  it("picks the cheapest model within 5% of the best Georgian score", () => {
    const decision = make([
      { model: "a/best", ka: 20, cost: 30 },
      { model: "b/close", ka: 19.2, cost: 3 },
      { model: "c/cheapest-but-worse", ka: 16, cost: 1 },
    ]);
    expect(decision.best?.model).toBe("a/best");
    expect(decision.threshold).toBeCloseTo(20 * GEORGIAN_TOLERANCE);
    expect(decision.winner).toBe("b/close");
    expect(decision.eligible.map((item) => item.model)).toEqual(["b/close", "a/best"]);
  });

  it("disqualifies a model that is not schema-perfect, however good and cheap", () => {
    const decision = make([
      { model: "a/flaky", ka: 20, cost: 1, schemaValid: false },
      { model: "b/solid", ka: 16, cost: 9 },
    ]);
    expect(decision.candidates.map((item) => item.model)).toEqual(["b/solid"]);
    expect(decision.winner).toBe("b/solid");
  });

  it("refuses to pick when nothing is schema-perfect", () => {
    const decision = make([{ model: "a/flaky", ka: 20, cost: 1, schemaValid: false }]);
    expect(decision.winner).toBeNull();
    expect(decision.reason).toMatch(/schema-valid/u);
  });

  it("refuses to pick before the judge has run", () => {
    const files = [
      runFile("a/model", [record({ caseId: "ka-1", model: "a/model", langFrom: "ka" })]),
    ];
    const decision = decide(aggregate(files, null));
    expect(decision.winner).toBeNull();
    expect(decision.reason).toMatch(/eval:judge/u);
  });
});

describe("lowestGeorgian", () => {
  it("returns the worst-judged Georgian cards first", () => {
    const runs = [
      runFile("a/model", [
        record({ caseId: "ka-1", model: "a/model", langFrom: "ka" }),
        record({ caseId: "ka-2", model: "a/model", langFrom: "ka" }),
        record({ caseId: "en-1", model: "a/model", langFrom: "en" }),
      ]),
    ];
    const judge: JudgeFile = {
      runId: "r1",
      judgeModel: "j",
      createdAt: "",
      totalCostUsd: 0,
      assignments: {},
      scores: [
        score("ka-1", "a/model", 5, "ok"),
        score("ka-2", "a/model", 2, "wrong masdar"),
        score("en-1", "a/model", 1, "nonsense"),
      ],
      errors: [],
    };
    const rows = lowestGeorgian(runs, judge, "a/model", 10, new Map([["ka-2", "სახლი"]]));
    expect(rows.map((row) => row.caseId)).toEqual(["ka-2", "ka-1"]);
    expect(rows[0]?.total).toBe(8);
    expect(rows[0]?.issue).toBe("wrong masdar");
    expect(rows[0]?.front).toBe("სახლი");
    expect(rows[0]?.text).toBe("სახლი");
    expect(rows[1]?.text).toBe("");
  });

  it("returns nothing without a judge file", () => {
    expect(lowestGeorgian([], null, "a/model")).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("writes the decision, the tables and the weak Georgian cards", () => {
    const runs = [
      runFile("a/model", [record({ caseId: "ka-1", model: "a/model", langFrom: "ka" })]),
    ];
    const judge: JudgeFile = {
      runId: "r1",
      judgeModel: "judge/model",
      createdAt: "",
      totalCostUsd: 1.25,
      assignments: {},
      scores: [score("ka-1", "a/model", 4)],
      errors: [],
    };
    const aggregation = aggregate(runs, judge);
    const markdown = renderMarkdown(aggregation, decide(aggregation), [
      { model: "a/model", rows: lowestGeorgian(runs, judge, "a/model") },
    ]);
    expect(markdown).toContain("# LLM card-generation eval — run `r1`");
    expect(markdown).toContain("## Decision");
    expect(markdown).toContain("judge/model");
    expect(markdown).toContain("## Language: ka");
    expect(markdown).toContain("სახლი");
    expect(markdown).toContain("| --- |");
  });
});

describe("judge blinding", () => {
  it("shuffles deterministically per case id", () => {
    const models = ["a", "b", "c", "d", "e"];
    expect(shuffleDeterministic(models, "ka-1")).toEqual(shuffleDeterministic(models, "ka-1"));
    expect(shuffleDeterministic(models, "ka-1")).not.toEqual(shuffleDeterministic(models, "ka-2"));
    expect([...shuffleDeterministic(models, "ka-1")].sort()).toEqual(models);
    expect(hashSeed("ka-1")).toBe(hashSeed("ka-1"));
  });

  it("labels A, B, C", () => {
    expect([0, 1, 2].map(labelFor)).toEqual(["A", "B", "C"]);
  });

  it("clamps scores into 1..5", () => {
    expect([0, 1, 3.4, 5, 9, Number.NaN].map(clampScore)).toEqual([1, 1, 3, 5, 5, 1]);
  });

  it("tells the judge when the input is junk", () => {
    const junk: EvalCase = {
      id: "ka-junk-asdfgh",
      text: "asdfgh",
      langFrom: "ka",
      langTo: "ru",
      category: "junk",
      note: "Only schema validity is checked.",
    };
    const message = buildJudgeMessage(junk, [
      { label: "A", record: record({ caseId: junk.id, model: "m", langFrom: "ka" }) },
    ]);
    expect(message).toContain("NOT a real word");
    expect(message).not.toContain("Only schema validity");
  });

  it("shows expectations but never a model name", () => {
    const evalCase: EvalCase = {
      id: "ka-conj-vkitxulob",
      text: "ვკითხულობ",
      langFrom: "ka",
      langTo: "ru",
      category: "inflected",
      expect: { detectedLang: "ka", front: "კითხვა", pos: "verb", backIncludesAny: ["чита"] },
      note: "1sg present of 'read'.",
    };
    const message = buildJudgeMessage(evalCase, [
      {
        label: "A",
        record: record({ caseId: evalCase.id, model: "secret/model", langFrom: "ka" }),
      },
    ]);
    expect(message).toContain('Input: "ვკითხულობ"');
    expect(message).toContain('canonical form should be "კითხვა"');
    expect(message).toContain("1sg present");
    expect(message).toContain('A) front="სახლი"');
    expect(message).not.toContain("secret/model");
  });
});

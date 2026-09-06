/**
 * `pnpm eval:run` — call every model on every case, check the answers, save
 * everything under `results/<run-id>/<model-slug>.json`.
 *
 *   OPENROUTER_API_KEY=... pnpm eval:run [--models a,b] [--cases path]
 *                                        [--out dir] [--run id] [--repeat 1]
 *                                        [--concurrency 4]
 *
 * Re-running with the same `--run` id resumes: (model, case, repeat) triples
 * already on disk are skipped.
 */

import { runChecks } from "./checks.js";
import {
  baseUrlOverride,
  intArg,
  listArg,
  parseArgs,
  requireApiKey,
  stringArg,
  usd,
} from "./cli.js";
import { createLimiter, OpenRouterClient, suggestModels } from "./openrouter.js";
import { buildUserMessage, CARD_JSON_SCHEMA, parseCard, SYSTEM_PROMPT } from "./prompt.js";
import {
  DEFAULT_CASES_PATH,
  DEFAULT_RESULTS_DIR,
  ensureDir,
  modelFilePath,
  newRunId,
  readModelRun,
  runDir,
  writeModelRun,
} from "./store.js";
import {
  type CallRecord,
  type EvalCase,
  loadCases,
  type ModelRunFile,
  type UsageRecord,
} from "./types.js";

/**
 * Candidate line-up. Ids are validated against `GET /models` at start-up;
 * anything unknown is skipped with a "did you mean" hint.
 */
export const DEFAULT_MODELS = [
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.7-flash",
  "google/gemini-3.1-flash-lite",
  "openai/gpt-5-mini",
  "openai/gpt-5.6-luna",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
];

const NO_USAGE: UsageRecord = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Models that think before answering: cap the effort so the JSON card is not starved. */
export function isReasoningModel(model: string): boolean {
  return /^(openai\/(gpt-5|o\d)|deepseek\/.*(r1|reason)|x-ai\/grok-\d)/u.test(model);
}

/** One model × case × repeat call, never throwing: failures become records. */
async function callOne(
  client: OpenRouterClient,
  model: string,
  evalCase: EvalCase,
  repeat: number,
): Promise<CallRecord> {
  const started = Date.now();
  const base = {
    caseId: evalCase.id,
    model,
    repeat,
    langFrom: evalCase.langFrom,
    category: evalCase.category,
  };
  try {
    const result = await client.chat({
      model,
      system: SYSTEM_PROMPT,
      user: buildUserMessage(evalCase),
      schema: CARD_JSON_SCHEMA,
      // Reasoning models spend the budget on thinking first; leave room for the card.
      maxTokens: 4_000,
      ...(isReasoningModel(model) ? { reasoningEffort: "low" as const } : {}),
    });
    try {
      const card = parseCard(result.text);
      return {
        ...base,
        raw: result.text,
        card,
        error: null,
        latencyMs: result.latencyMs,
        usage: result.usage,
        mode: result.mode,
        checks: runChecks(evalCase, card),
      };
    } catch (error) {
      const detail = `invalid_output: ${message(error)}`;
      return {
        ...base,
        raw: result.text,
        card: null,
        error: detail,
        latencyMs: result.latencyMs,
        usage: result.usage,
        mode: result.mode,
        checks: runChecks(evalCase, null, detail),
      };
    }
  } catch (error) {
    const detail = message(error);
    return {
      ...base,
      raw: "",
      card: null,
      error: detail,
      latencyMs: Date.now() - started,
      usage: { ...NO_USAGE },
      mode: null,
      checks: runChecks(evalCase, null, detail),
    };
  }
}

/** Top distinct error messages with counts, so a systematic failure shows up in the logs. */
export function failureSummary(records: readonly CallRecord[], top = 5): string[] {
  const counts = new Map<string, { n: number; cases: string[] }>();
  for (const record of records) {
    if (record.error === null) continue;
    const key = record.error.replace(/\s+/gu, " ").slice(0, 160);
    const entry = counts.get(key) ?? { n: 0, cases: [] };
    entry.n += 1;
    if (entry.cases.length < 3) entry.cases.push(record.caseId);
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, top)
    .map(([error, { n, cases }]) => `✗ ${n}× ${error} (e.g. ${cases.join(", ")})`);
}

/** Keeps the file in case order so a human can diff two runs. */
function sortRecords(records: CallRecord[], order: ReadonlyMap<string, number>): CallRecord[] {
  return records
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0) ||
        a.repeat - b.repeat ||
        a.caseId.localeCompare(b.caseId),
    );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = requireApiKey();
  const casesPath = stringArg(args, "cases", DEFAULT_CASES_PATH);
  const resultsDir = stringArg(args, "out", DEFAULT_RESULTS_DIR);
  const runId = stringArg(args, "run", newRunId());
  const repeats = intArg(args, "repeat", 1);
  const retryFailed = args["retry-failed"] === true || process.env.EVAL_RETRY_FAILED === "1";
  const concurrency = intArg(args, "concurrency", 2);
  const rpm = intArg(args, "rpm", 18);
  const requested = listArg(args, "models") ?? DEFAULT_MODELS;

  const cases = loadCases(casesPath);
  const order = new Map(cases.map((item, index) => [item.id, index]));
  const dir = runDir(resultsDir, runId);
  ensureDir(dir);

  const client = new OpenRouterClient({
    apiKey,
    baseUrl: baseUrlOverride(),
    referer: "https://github.com/tganki/tganki",
    title: "tganki card-generation eval",
    rpm,
    maxAttempts: 5,
  });

  let models = requested;
  try {
    const available = await client.listModels();
    if (available.length > 0) {
      const known = new Set(available);
      const missing = requested.filter((model) => !known.has(model));
      for (const model of missing) {
        const hints = suggestModels(model, available);
        console.warn(
          `! unknown model id "${model}" — skipping.${
            hints.length > 0 ? ` Closest ids: ${hints.join(", ")}` : ""
          }`,
        );
      }
      models = requested.filter((model) => known.has(model));
    } else {
      console.warn("! /models returned nothing — running without id validation.");
    }
  } catch (error) {
    console.warn(`! could not validate model ids (${message(error)}) — running anyway.`);
  }

  if (models.length === 0) {
    console.error("No usable model ids. Pass --models with ids from https://openrouter.ai/models.");
    process.exit(1);
  }

  console.log(`run ${runId} · ${models.length} models × ${cases.length} cases × ${repeats}`);
  console.log(`out ${dir}`);

  let grandTotal = 0;
  for (const [index, model] of models.entries()) {
    const existing = readModelRun(dir, model);
    const run: ModelRunFile = existing ?? {
      runId,
      model,
      createdAt: new Date().toISOString(),
      records: [],
    };
    const prefix = `[${index + 1}/${models.length}] ${model}`;
    if (retryFailed) {
      const before = run.records.length;
      run.records = run.records.filter((record) => record.error === null);
      const dropped = before - run.records.length;
      if (dropped > 0) console.log(`${prefix} — retrying ${dropped} failed records`);
    }
    const done = new Set(run.records.map((record) => `${record.caseId}#${record.repeat}`));
    const todo: { evalCase: EvalCase; repeat: number }[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const evalCase of cases) {
        if (!done.has(`${evalCase.id}#${repeat}`)) todo.push({ evalCase, repeat });
      }
    }

    if (todo.length === 0) {
      const failed = run.records.filter((record) => record.error !== null).length;
      console.log(
        `${prefix} — nothing to do (${run.records.length} records on disk, ${failed} failed)`,
      );
      for (const line of failureSummary(run.records)) console.log(`${prefix}   ${line}`);
      grandTotal += run.records.reduce((sum, record) => sum + record.usage.costUsd, 0);
      continue;
    }
    console.log(`${prefix} — ${todo.length} calls (${done.size} already done)`);

    const limit = createLimiter(concurrency);
    let finished = 0;
    await Promise.all(
      todo.map((task) =>
        limit(async () => {
          const record = await callOne(client, model, task.evalCase, task.repeat);
          run.records.push(record);
          run.records = sortRecords(run.records, order);
          writeModelRun(dir, run);
          finished += 1;
          if (finished % 20 === 0 || finished === todo.length) {
            console.log(`${prefix}   ${finished}/${todo.length}`);
          }
        }),
      ),
    );

    const errors = run.records.filter((record) => record.error !== null).length;
    const cost = run.records.reduce((sum, record) => sum + record.usage.costUsd, 0);
    grandTotal += cost;
    for (const line of failureSummary(run.records)) console.log(`${prefix}   ${line}`);
    const fallbacks = run.records.filter((record) => record.mode === "json_object").length;
    console.log(
      `${prefix} — done: ${run.records.length} records, ${errors} failed, ${usd(cost)}` +
        (fallbacks > 0 ? `, ${fallbacks} via json_object fallback` : "") +
        ` → ${modelFilePath(dir, model)}`,
    );
  }

  console.log(`total measured cost: ${usd(grandTotal)}`);
  console.log(`next: pnpm eval:judge --run ${runId}`);
}

main().catch((error: unknown) => {
  console.error(message(error));
  process.exit(1);
});

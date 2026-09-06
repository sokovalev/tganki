/**
 * `pnpm eval:judge` — blind comparative judging.
 *
 *   OPENROUTER_API_KEY=... pnpm eval:judge [--run <run-id>] [--out dir]
 *                                          [--judge anthropic/claude-opus-5]
 *                                          [--cases path] [--concurrency 4]
 *
 * One judge call per case: every model's card for that case is shuffled,
 * labelled A/B/C… and scored 1–5 on four criteria. The judge sees the case and
 * its expectations but never a model name. Resumable — cases already in
 * `judge.json` are skipped.
 */

import { createLimiter, OpenRouterClient } from "../../src/llm/openrouter.js";
import { extractJson } from "../../src/llm/prompt.js";
import {
  baseUrlOverride,
  intArg,
  optionalStringArg,
  parseArgs,
  requireApiKey,
  stringArg,
  usd,
} from "./cli.js";
import {
  buildJudgeMessage,
  clampScore,
  JUDGE_JSON_SCHEMA,
  JUDGE_SCHEMA_NAME,
  JUDGE_SYSTEM_PROMPT,
  judgeReplySchema,
  labelFor,
  shuffleDeterministic,
} from "./judgePrompt.js";
import {
  DEFAULT_CASES_PATH,
  DEFAULT_RESULTS_DIR,
  latestRunId,
  readAllModelRuns,
  readJudge,
  runDir,
  writeJudge,
} from "./store.js";
import { type CallRecord, type JudgeFile, type JudgeScore, loadCases } from "./types.js";

const DEFAULT_JUDGE_MODEL = "anthropic/claude-opus-5";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = requireApiKey();
  const resultsDir = stringArg(args, "out", DEFAULT_RESULTS_DIR);
  const runId = optionalStringArg(args, "run") ?? latestRunId(resultsDir);
  if (runId === null) {
    console.error(`No runs in ${resultsDir}. Run \`pnpm eval:run\` first.`);
    process.exit(1);
  }
  const judgeModel = stringArg(args, "judge", DEFAULT_JUDGE_MODEL);
  const concurrency = intArg(args, "concurrency", 2);
  const cases = loadCases(stringArg(args, "cases", DEFAULT_CASES_PATH));
  const dir = runDir(resultsDir, runId);
  const runs = readAllModelRuns(dir);
  if (runs.length === 0) {
    console.error(`No model results in ${dir}.`);
    process.exit(1);
  }

  const judge: JudgeFile = readJudge(dir) ?? {
    runId,
    judgeModel,
    createdAt: new Date().toISOString(),
    totalCostUsd: 0,
    assignments: {},
    scores: [],
    errors: [],
  };
  judge.judgeModel = judgeModel;

  const client = new OpenRouterClient({
    apiKey,
    baseUrl: baseUrlOverride(),
    referer: "https://github.com/tganki/tganki",
    title: "tganki card-generation eval (judge)",
    rpm: intArg(args, "rpm", 18),
    maxAttempts: 5,
    // Offline batch job: a judge call may think for a while.
    timeoutMs: 60_000,
  });
  const limit = createLimiter(concurrency);

  // A case judged while some models still had failed records compares fewer
  // labels than are available now: drop it so every model is scored on the
  // same cases. Errors from earlier attempts are not carried over either.
  judge.errors = [];
  let stale = 0;
  for (const evalCase of cases) {
    const assignment = judge.assignments[evalCase.id];
    if (assignment === undefined) continue;
    const available = runs.filter((run) =>
      run.records.some((r) => r.caseId === evalCase.id && r.repeat === 0 && r.card !== null),
    ).length;
    if (Object.keys(assignment).length < available) {
      delete judge.assignments[evalCase.id];
      judge.scores = judge.scores.filter((score) => score.caseId !== evalCase.id);
      stale += 1;
    }
  }
  if (stale > 0) console.log(`re-judging ${stale} cases that were scored with fewer models`);
  const pending = cases.filter((evalCase) => judge.assignments[evalCase.id] === undefined);
  console.log(
    `judging run ${runId} with ${judgeModel}: ${pending.length} cases (${cases.length - pending.length} already done), ${runs.length} models`,
  );

  let finished = 0;
  await Promise.all(
    pending.map((evalCase) =>
      limit(async () => {
        const cards = runs
          .map((run) => run.records.find((r) => r.caseId === evalCase.id && r.repeat === 0))
          .filter((record): record is CallRecord => record !== undefined && record.card !== null);
        if (cards.length === 0) {
          judge.assignments[evalCase.id] = {};
          return;
        }
        const labelled = shuffleDeterministic(cards, evalCase.id).map((record, index) => ({
          label: labelFor(index),
          record,
        }));
        try {
          const result = await client.chat({
            model: judgeModel,
            system: JUDGE_SYSTEM_PROMPT,
            user: buildJudgeMessage(evalCase, labelled),
            schema: JUDGE_JSON_SCHEMA,
            schemaName: JUDGE_SCHEMA_NAME,
            maxTokens: 1500,
          });
          const reply = judgeReplySchema.parse(extractJson(result.text));
          const byLabel = new Map(labelled.map((item) => [item.label, item.record.model]));
          const scores: JudgeScore[] = [];
          for (const score of reply.scores) {
            const model = byLabel.get(score.label.trim().toUpperCase());
            if (model === undefined) continue;
            scores.push({
              caseId: evalCase.id,
              model,
              label: score.label.trim().toUpperCase(),
              translation: clampScore(score.translation),
              canonical: clampScore(score.canonical),
              example: clampScore(score.example),
              transcription: clampScore(score.transcription),
              issue: score.issue.trim(),
            });
          }
          judge.assignments[evalCase.id] = Object.fromEntries(
            labelled.map((item) => [item.label, item.record.model]),
          );
          judge.scores.push(...scores);
          judge.totalCostUsd += result.usage.costUsd;
        } catch (error) {
          judge.errors.push({ caseId: evalCase.id, message: message(error) });
        }
        writeJudge(dir, judge);
        finished += 1;
        if (finished % 20 === 0 || finished === pending.length) {
          console.log(`  ${finished}/${pending.length} · ${usd(judge.totalCostUsd)}`);
        }
      }),
    ),
  );

  judge.scores.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.model.localeCompare(b.model));
  writeJudge(dir, judge);
  console.log(
    `judged ${Object.keys(judge.assignments).length} cases, ${judge.errors.length} errors, total judge cost ${usd(judge.totalCostUsd)}`,
  );
  console.log(`next: pnpm eval:report --run ${runId}`);
}

main().catch((error: unknown) => {
  console.error(message(error));
  process.exit(1);
});

/**
 * `pnpm eval:report` — aggregate a run, apply the decision rule, write
 * `results/<run-id>/REPORT.md`.
 *
 *   pnpm eval:report [--run <run-id>] [--out dir]
 *
 * No API key needed: this only reads what `eval:run` and `eval:judge` wrote.
 */

import {
  aggregate,
  decide,
  type GeorgianSample,
  lowestGeorgian,
  renderMarkdown,
} from "./aggregate.js";
import { optionalStringArg, parseArgs, stringArg, usd } from "./cli.js";
import {
  DEFAULT_CASES_PATH,
  DEFAULT_RESULTS_DIR,
  latestRunId,
  readAllModelRuns,
  readJudge,
  runDir,
  writeReport,
} from "./store.js";
import { loadCases } from "./types.js";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const resultsDir = stringArg(args, "out", DEFAULT_RESULTS_DIR);
  const runId = optionalStringArg(args, "run") ?? latestRunId(resultsDir);
  if (runId === null) {
    console.error(`No runs in ${resultsDir}. Run \`pnpm eval:run\` first.`);
    process.exit(1);
  }
  const dir = runDir(resultsDir, runId);
  const runs = readAllModelRuns(dir);
  if (runs.length === 0) {
    console.error(`No model results in ${dir}.`);
    process.exit(1);
  }
  const judge = readJudge(dir);
  let inputs = new Map<string, string>();
  try {
    inputs = new Map(
      loadCases(stringArg(args, "cases", DEFAULT_CASES_PATH)).map((item) => [item.id, item.text]),
    );
  } catch {
    // The report is still useful without the original inputs.
  }
  const aggregation = aggregate(runs, judge);
  const decision = decide(aggregation);

  const ranked = [...aggregation.models].sort(
    (a, b) => (b.byLang.ka?.judge?.total ?? 0) - (a.byLang.ka?.judge?.total ?? 0),
  );
  const samples: { model: string; rows: GeorgianSample[] }[] = ranked.slice(0, 2).map((model) => ({
    model: model.model,
    rows: lowestGeorgian(runs, judge, model.model, 10, inputs),
  }));

  const width = Math.max(...aggregation.models.map((model) => model.model.length), 5);
  console.log(`run ${runId} · ${aggregation.models.length} models`);
  console.log(
    [
      pad("model", width),
      pad("schema", 8),
      pad("checks", 8),
      pad("judge", 8),
      pad("ka judge", 9),
      pad("p50", 7),
      "$/1000",
    ].join(" "),
  );
  for (const model of aggregation.models) {
    console.log(
      [
        pad(model.model, width),
        pad(pct(model.schemaValidRate), 8),
        pad(pct(model.checkPassRate), 8),
        pad(model.judge === null ? "—" : model.judge.total.toFixed(2), 8),
        pad(model.byLang.ka?.judge?.total.toFixed(2) ?? "—", 9),
        pad(`${Math.round(model.p50LatencyMs)}ms`, 7),
        model.costPer1000Usd === null ? "—" : usd(model.costPer1000Usd),
      ].join(" "),
    );
  }
  console.log("");
  console.log(
    decision.winner === null ? `No pick: ${decision.reason}` : `Pick: ${decision.reason}`,
  );

  const path = writeReport(dir, renderMarkdown(aggregation, decision, samples));
  console.log(`wrote ${path}`);
}

main();

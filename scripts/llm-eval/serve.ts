/**
 * Container entrypoint for running the evaluation on Railway (or anywhere
 * with an OPENROUTER_API_KEY): starts a tiny HTTP server that serves the
 * report, then runs `run → judge → report` once. All three stages resume,
 * so a redeploy continues an interrupted run instead of paying twice.
 *
 * Env: OPENROUTER_API_KEY (required to run), EVAL_OUT (results dir,
 * default ./scripts/llm-eval/results), EVAL_RUN_ID (default "railway"),
 * EVAL_MODELS (comma-separated OpenRouter ids, optional), EVAL_JUDGE
 * (optional judge model id), PORT (default 3000).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DEFAULT_RESULTS_DIR, HERE, runDir } from "./store.js";

const port = Number(process.env.PORT ?? 3000);
const resultsDir = resolve(process.env.EVAL_OUT ?? DEFAULT_RESULTS_DIR);
const runId = process.env.EVAL_RUN_ID?.trim() || "railway";
const dir = runDir(resultsDir, runId);

const state = {
  stage: "idle" as "idle" | "run" | "judge" | "report" | "done" | "failed",
  log: [] as string[],
};

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  state.log.push(stamped);
  if (state.log.length > 500) state.log.shift();
  console.log(stamped);
}

function stage(script: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const tsx = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [join(HERE, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) log(`[${script}] ${line}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) log(`[${script}] ${line}`);
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`${script} exited with ${code}`)),
    );
  });
}

async function pipeline(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    log("OPENROUTER_API_KEY is not set; serving previous results only");
    state.stage = existsSync(join(dir, "REPORT.md")) ? "done" : "idle";
    return;
  }
  const common = ["--out", resultsDir, "--run", runId];
  const models = process.env.EVAL_MODELS?.trim();
  const judge = process.env.EVAL_JUDGE?.trim();
  try {
    state.stage = "run";
    await stage("run.ts", models ? [...common, "--models", models] : common);
    state.stage = "judge";
    await stage("judge.ts", judge ? [...common, "--judge", judge] : common);
    state.stage = "report";
    await stage("report.ts", common);
    state.stage = "done";
    const report = join(dir, "REPORT.md");
    if (existsSync(report)) {
      log("===== REPORT.md =====");
      for (const line of readFileSync(report, "utf8").split("\n")) console.log(line);
      log("===== end of report =====");
    }
  } catch (error) {
    state.stage = "failed";
    log(`pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const text = (code: number, body: string, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  if (url.pathname === "/health") return text(200, "ok");
  if (url.pathname === "/report") {
    const report = join(dir, "REPORT.md");
    return existsSync(report)
      ? text(200, readFileSync(report, "utf8"), "text/markdown; charset=utf-8")
      : text(404, `no report yet (stage: ${state.stage})`);
  }
  if (url.pathname === "/log") return text(200, state.log.join("\n"));
  if (url.pathname.startsWith("/results/")) {
    const rel = decodeURIComponent(url.pathname.slice("/results/".length));
    const full = resolve(resultsDir, rel);
    if (!full.startsWith(resultsDir) || !existsSync(full) || statSync(full).isDirectory()) {
      return text(404, "not found");
    }
    return text(200, readFileSync(full, "utf8"), "application/json; charset=utf-8");
  }
  const files = listFiles(resultsDir).map((f) => `  /results/${f}`);
  return text(
    200,
    [
      `tganki llm-eval · run "${runId}" · stage: ${state.stage}`,
      "",
      "  /report   — REPORT.md of this run",
      "  /log      — pipeline log (last 500 lines)",
      "  /health",
      "",
      "results:",
      ...(files.length ? files : ["  (none yet)"]),
    ].join("\n"),
  );
});

server.listen(port, () => {
  log(`llm-eval serving on :${port}, results in ${resultsDir}, run id "${runId}"`);
  void pipeline();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

/** Where results live on disk, and how runs are resumed. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeFile, ModelRunFile } from "./types.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_DIR = join(HERE, "results");
export const DEFAULT_CASES_PATH = join(HERE, "cases.json");

/** `2026-09-06T14-03-27` — sortable, filesystem-safe. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/\..*$/u, "").replace(/:/gu, "-");
}

/** `anthropic/claude-opus-5` -> `anthropic__claude-opus-5`. */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]+/gu, "__");
}

export function runDir(resultsDir: string, runId: string): string {
  return join(resultsDir, runId);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Newest run id in `resultsDir`, or null when there is none. */
export function latestRunId(resultsDir: string): string | null {
  if (!existsSync(resultsDir)) return null;
  const dirs = readdirSync(resultsDir)
    .filter((name) => statSync(join(resultsDir, name)).isDirectory())
    .sort();
  return dirs.at(-1) ?? null;
}

export function modelFilePath(dir: string, model: string): string {
  return join(dir, `${modelSlug(model)}.json`);
}

export function readModelRun(dir: string, model: string): ModelRunFile | null {
  const path = modelFilePath(dir, model);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ModelRunFile;
}

export function writeModelRun(dir: string, run: ModelRunFile): void {
  ensureDir(dir);
  writeFileSync(modelFilePath(dir, run.model), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

/** Every `<model>.json` in a run directory (judge.json excluded). */
export function readAllModelRuns(dir: string): ModelRunFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "judge.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ModelRunFile);
}

export function judgeFilePath(dir: string): string {
  return join(dir, "judge.json");
}

export function readJudge(dir: string): JudgeFile | null {
  const path = judgeFilePath(dir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as JudgeFile;
}

export function writeJudge(dir: string, judge: JudgeFile): void {
  ensureDir(dir);
  writeFileSync(judgeFilePath(dir), `${JSON.stringify(judge, null, 2)}\n`, "utf8");
}

export function writeReport(dir: string, markdown: string): string {
  ensureDir(dir);
  const path = join(dir, "REPORT.md");
  writeFileSync(path, markdown, "utf8");
  return path;
}

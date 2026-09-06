/**
 * Minimal OpenRouter client: chat completions with structured output, a
 * `json_object` fallback for providers that reject `json_schema`, bounded
 * retries, a timeout and a concurrency limiter. `fetch` is injectable so the
 * tests never touch the network.
 *
 * Shared by the bot (`src/llm/generator.ts`) and the offline evaluation
 * harness (`scripts/llm-eval/`), which is why it lives in `src/`.
 */

import { CARD_SCHEMA_NAME, type JsonSchema, systemPromptWithSchema } from "./prompt.js";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** How the JSON answer was requested; providers that reject schemas fall back. */
export type ResponseMode = "json_schema" | "json_object";

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD, as reported by OpenRouter (`usage.cost`). */
  costUsd: number;
}

/** Per-attempt timeout in production: the user is staring at «⏳ Подбираю перевод…». */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-attempt timeout. Defaults to 15 s — a bot user is waiting. */
  timeoutMs?: number;
  /** Total attempts per request, including the first one. */
  maxAttempts?: number;
  /** Base backoff; attempt n waits `backoffMs * 2 ** (n - 1)`. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  referer?: string;
  title?: string;
  /**
   * Max requests per minute started by this client (OpenRouter limits new
   * accounts to 20 rpm per model). Unset = no pacing.
   */
  rpm?: number;
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  schema?: JsonSchema;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  /** OpenRouter's unified reasoning control; needed so reasoning models leave tokens for the answer. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Force a mode instead of trying `json_schema` first. */
  mode?: ResponseMode;
}

export interface ChatResult {
  text: string;
  usage: UsageRecord;
  mode: ResponseMode;
  latencyMs: number;
  attempts: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

const EMPTY_USAGE: UsageRecord = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads OpenRouter's `usage` block (`usage: { include: true }` adds `cost`). */
export function parseUsage(payload: unknown): UsageRecord {
  if (typeof payload !== "object" || payload === null) return { ...EMPTY_USAGE };
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return { ...EMPTY_USAGE };
  const record = usage as Record<string, unknown>;
  return {
    promptTokens: number(record.prompt_tokens),
    completionTokens: number(record.completion_tokens),
    totalTokens: number(record.total_tokens),
    costUsd: number(record.cost),
  };
}

/** Pulls the assistant text out of a chat-completions payload. */
export function parseContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenRouterError("no choices in response", 200, JSON.stringify(payload));
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined,
      )
      .filter((part): part is string => typeof part === "string")
      .join("");
    if (text !== "") return text;
  }
  throw new OpenRouterError("empty content in response", 200, JSON.stringify(payload));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;
  private readonly minGapMs: number;
  private nextSlot = 0;

  constructor(options: OpenRouterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.referer = options.referer;
    this.title = options.title;
    this.minGapMs = options.rpm !== undefined && options.rpm > 0 ? 60_000 / options.rpm : 0;
  }

  /** Spaces request starts evenly so a burst never exceeds `rpm`. */
  private async pace(): Promise<void> {
    if (this.minGapMs === 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minGapMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer !== undefined) headers["HTTP-Referer"] = this.referer;
    if (this.title !== undefined) headers["X-Title"] = this.title;
    return headers;
  }

  /** One HTTP call with retries on 429/5xx/network errors. */
  private async send(
    path: string,
    init: RequestInit,
    state: { attempts: number },
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      state.attempts += 1;
      let retryAfterMs = 0;
      try {
        await this.pace();
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: this.headers(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return await response.json();
        const body = await response.text().catch(() => "");
        const error = new OpenRouterError(
          `OpenRouter ${response.status}: ${body.slice(0, 400)}`,
          response.status,
          body,
        );
        if (!isRetryableStatus(response.status) || attempt === this.maxAttempts) throw error;
        if (response.status === 429) {
          // Rate limits are per minute: back off for the window, honouring Retry-After.
          const header = Number(response.headers.get("retry-after") ?? "");
          retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1_000 : 20_000;
        }
        lastError = error;
      } catch (caught) {
        if (caught instanceof OpenRouterError && !isRetryableStatus(caught.status)) throw caught;
        if (attempt === this.maxAttempts) throw caught;
        lastError = caught;
      }
      await this.sleep(Math.max(retryAfterMs, this.backoffMs * 2 ** (attempt - 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("request failed");
  }

  /** GET /models — used to validate the model ids before a run. */
  async listModels(): Promise<string[]> {
    const payload = await this.send("/models", { method: "GET" }, { attempts: 0 });
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) =>
        typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined,
      )
      .filter((id): id is string => typeof id === "string");
  }

  private body(request: ChatRequest, mode: ResponseMode): string {
    const schema = request.schema;
    const system =
      mode === "json_object" && schema
        ? systemPromptWithSchema(request.system, schema)
        : request.system;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: request.user },
    ];
    const responseFormat =
      mode === "json_schema" && schema
        ? {
            type: "json_schema",
            json_schema: { name: request.schemaName ?? CARD_SCHEMA_NAME, strict: true, schema },
          }
        : { type: "json_object" };
    return JSON.stringify({
      model: request.model,
      messages,
      response_format: responseFormat,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 600,
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      usage: { include: true },
    });
  }

  /**
   * Chat completion. Tries `json_schema`; if the provider rejects it with a
   * 400, retries once in `json_object` mode with the schema pasted into the
   * system prompt. The mode that worked is reported back.
   */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const state = { attempts: 0 };
    const first: ResponseMode = request.mode ?? (request.schema ? "json_schema" : "json_object");
    const call = async (mode: ResponseMode): Promise<ChatResult> => {
      const payload = await this.send(
        "/chat/completions",
        { method: "POST", body: this.body(request, mode) },
        state,
      );
      return {
        text: parseContent(payload),
        usage: parseUsage(payload),
        mode,
        latencyMs: Date.now() - started,
        attempts: state.attempts,
      };
    };
    try {
      return await call(first);
    } catch (caught) {
      const rejectedSchema =
        first === "json_schema" &&
        request.mode === undefined &&
        caught instanceof OpenRouterError &&
        caught.status === 400;
      if (!rejectedSchema) throw caught;
      return await call("json_object");
    }
  }
}

/** Runs at most `max` tasks at a time; preserves the caller's promise semantics. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        task().then(
          (value) => {
            next();
            resolve(value);
          },
          (error: unknown) => {
            next();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      };
      if (active < limit) start();
      else queue.push(start);
    });
}

function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const value = (previous[j - 1] ?? 0) + 1;
        current[j] = value;
        if (value > best) best = value;
      }
    }
    previous = current;
  }
  return best;
}

/** Closest ids by longest common substring — for "did you mean" on a typo'd model id. */
export function suggestModels(unknown: string, available: readonly string[], limit = 5): string[] {
  const needle = unknown.toLowerCase();
  return available
    .map((id) => ({ id, score: longestCommonSubstring(needle, id.toLowerCase()) }))
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

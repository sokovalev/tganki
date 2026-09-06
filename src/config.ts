import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

/** "true"/"1"/"yes"/"on" (case-insensitive) enable the flag; anything else disables it. */
const boolFlag = (fallback: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? fallback
        : ["true", "1", "yes", "on"].includes(value.toLowerCase()),
    );

/** Comma-separated list of Telegram ids; blanks and non-numbers are dropped. */
const tgIdList = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id !== 0),
  );

/** A price in Telegram Stars; blank falls back to the catalog default (SPEC §9.2). */
const starPrice = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? fallback : Number(value)))
    .refine(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100_000,
      "must be a whole number of Stars between 1 and 100000",
    );

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: optionalString.refine(
    (value) => value === undefined || URL.canParse(value),
    "PUBLIC_URL must be an absolute URL",
  ),
  /** OpenRouter key. Set = AI card generation is on (SPEC §4.1a), unset = manual only. */
  OPENROUTER_API_KEY: optionalString,
  /** OpenRouter model id; the eval in `scripts/llm-eval` picked the default. */
  LLM_MODEL: z.string().trim().min(1).default("google/gemini-3.7-flash"),
  /** Only sent when set; reasoning models need it to leave room for the answer. */
  LLM_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional(),
  /** Per-attempt timeout; a user is waiting on the «⏳» message. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Override the OpenRouter base URL (a proxy, or a mock in tests). */
  LLM_BASE_URL: optionalString,
  /** Shared secret in the webhook path and in `X-Telegram-Bot-Api-Secret-Token`. */
  WEBHOOK_SECRET: optionalString,
  /** Telegram ids allowed to run /admin. */
  ADMIN_TG_IDS: tgIdList,
  /** Master switch for Free-plan gating; false = everything is allowed. */
  PRO_ENABLED: boolFlag(false),
  /** `/pro` prices in Stars (SPEC §9.2). Admins always also see the 1-Star test product. */
  PRO_PRICE_MONTH: starPrice(199),
  PRO_PRICE_YEAR: starPrice(1499),
  PRO_PRICE_LIFETIME: starPrice(2999),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

/** AI card generation is enabled exactly when an OpenRouter key is configured. */
export function isLlmEnabled(config: Config): boolean {
  return config.OPENROUTER_API_KEY !== undefined;
}

/** Parse and validate the environment. Throws with a readable message on failure. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Memoized config for process-wide use (entrypoints only; pass Config explicitly elsewhere). */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

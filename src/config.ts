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

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: optionalString.refine(
    (value) => value === undefined || URL.canParse(value),
    "PUBLIC_URL must be an absolute URL",
  ),
  /** Reserved for the AI card generation phase; nothing reads it yet. */
  ANTHROPIC_API_KEY: optionalString,
  /** Shared secret in the webhook path and in `X-Telegram-Bot-Api-Secret-Token`. */
  WEBHOOK_SECRET: optionalString,
  /** Telegram ids allowed to run /admin. */
  ADMIN_TG_IDS: tgIdList,
  /** Master switch for Free-plan gating; false = everything is allowed. */
  PRO_ENABLED: boolFlag(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

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

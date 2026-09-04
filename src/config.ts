import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: optionalString.refine(
    (value) => value === undefined || URL.canParse(value),
    "PUBLIC_URL must be an absolute URL",
  ),
  ANTHROPIC_API_KEY: optionalString,
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

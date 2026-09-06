/** Tiny `--flag value` parser and console helpers shared by the three commands. */

export type Args = Record<string, string | boolean>;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function stringArg(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function optionalStringArg(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function intArg(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function listArg(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function requireApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.error("OPENROUTER_API_KEY is not set. See scripts/llm-eval/README.md.");
    process.exit(1);
  }
  return key;
}

/** `OPENROUTER_BASE_URL` overrides the API host (proxy, or a local fake in tests). */
export function baseUrlOverride(): string | undefined {
  const value = process.env.OPENROUTER_BASE_URL?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

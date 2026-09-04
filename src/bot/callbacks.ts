/**
 * Callback data is limited to 64 bytes by Telegram, so we encode compact
 * `ns:action:arg:arg` tuples instead of JSON. Namespaces are one to three
 * characters: `r` review, `s` session, `c` card actions, `a` add, `d` decks,
 * `o` onboarding, `set` settings, `st` stats, `lch` leech, `m` menu.
 */

export const MAX_CALLBACK_BYTES = 64;
export const CALLBACK_SEPARATOR = ":";

export interface ParsedCallback {
  ns: string;
  action: string;
  args: readonly string[];
}

const encoder = new TextEncoder();

export function callbackByteLength(data: string): number {
  return encoder.encode(data).length;
}

/**
 * Builds callback data and fails loudly when it would not fit — a 65-byte
 * button is rejected by Telegram at send time, which is much harder to debug.
 */
export function encodeCallback(
  ns: string,
  action = "",
  ...args: ReadonlyArray<string | number>
): string {
  const parts = [ns, action, ...args.map(String)];
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  for (const part of parts) {
    if (part.includes(CALLBACK_SEPARATOR)) {
      throw new Error(`callback part must not contain "${CALLBACK_SEPARATOR}": ${part}`);
    }
  }
  const data = parts.join(CALLBACK_SEPARATOR);
  if (callbackByteLength(data) > MAX_CALLBACK_BYTES) {
    throw new Error(`callback data is too long (${callbackByteLength(data)} bytes): ${data}`);
  }
  return data;
}

/** Splits raw callback data. Returns null for empty/oversized payloads. */
export function parseCallback(data: string | undefined | null): ParsedCallback | null {
  if (!data) return null;
  if (callbackByteLength(data) > MAX_CALLBACK_BYTES) return null;
  const [ns, action = "", ...args] = data.split(CALLBACK_SEPARATOR);
  if (!ns) return null;
  return { ns, action, args };
}

/** Positional integer argument, or null when missing/not a number. */
export function argInt(parsed: ParsedCallback, index: number): number | null {
  const raw = parsed.args[index];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function argStr(parsed: ParsedCallback, index: number): string | null {
  return parsed.args[index] ?? null;
}

/** True when the callback belongs to `ns` (and, if given, to `action`). */
export function matches(parsed: ParsedCallback | null, ns: string, action?: string): boolean {
  if (!parsed || parsed.ns !== ns) return false;
  return action === undefined || parsed.action === action;
}

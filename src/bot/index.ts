import { Bot } from "grammy";

/**
 * Placeholder bot factory: handlers, middleware and i18n land here in the
 * Telegram package. Kept thin on purpose — all logic lives in `src/core`.
 */
export function createBot(token: string): Bot {
  return new Bot(token);
}

export type { Bot };

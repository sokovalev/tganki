import type { I18n } from "@grammyjs/i18n";
import type { Bot } from "grammy";
import { SUPPORTED_LOCALES, translator } from "../i18n/index.js";
import type { BotContext } from "./context.js";

/** Commands shown in the Telegram menu (SPEC §2). */
export const COMMANDS = [
  "learn",
  "add",
  "decks",
  "stats",
  "settings",
  "undo",
  "pro",
  "help",
  "paysupport",
] as const;

export type CommandName = (typeof COMMANDS)[number];

const DESCRIPTION_KEYS: Record<CommandName, string> = {
  learn: "cmd-learn",
  add: "cmd-add",
  decks: "cmd-decks",
  stats: "cmd-stats",
  settings: "cmd-settings",
  undo: "cmd-undo",
  pro: "cmd-pro",
  help: "cmd-help",
  paysupport: "cmd-paysupport",
};

export function commandList(i18n: I18n<BotContext>, locale: string) {
  const t = translator(i18n, locale);
  return COMMANDS.map((command) => ({
    command,
    description: t(DESCRIPTION_KEYS[command]),
  }));
}

/** ru is the default list; every other supported locale gets its own. */
export async function registerCommands(
  bot: Bot<BotContext>,
  i18n: I18n<BotContext>,
): Promise<void> {
  await bot.api.setMyCommands(commandList(i18n, "ru"));
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === "ru") continue;
    await bot.api.setMyCommands(commandList(i18n, locale), { language_code: locale });
  }
}

import type { I18n } from "@grammyjs/i18n";
import type { Bot } from "grammy";
import type { BotContext } from "../bot/context.js";
import { htmlOptions, isBlockedError } from "../bot/ui.js";
import { translator } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import type { ReminderSender } from "../services/reminderService.js";
import { renderMessage } from "./render.js";

/**
 * Sends whatever the cron decided to send — the daily nudge, the streak
 * warning or the Monday report — and reports 403 back so the service can mark
 * the user blocked (SPEC §6.2).
 */
export function createReminderSender(
  bot: Bot<BotContext>,
  i18n: I18n<BotContext>,
  logger: Logger,
): ReminderSender {
  return {
    async send(user, message) {
      const screen = renderMessage(translator(i18n, user.uiLang), user.uiLang, message);
      try {
        await bot.api.sendMessage(user.tgId, screen.text, {
          ...htmlOptions,
          ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
        });
        return "sent";
      } catch (error) {
        if (isBlockedError(error)) return "blocked";
        logger.warn({ err: error, userId: user.id, kind: message.kind }, "reminder failed");
        return "failed";
      }
    },
  };
}

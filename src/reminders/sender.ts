import type { I18n } from "@grammyjs/i18n";
import { type Bot, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot/context.js";
import { cb, NS } from "../bot/keyboards.js";
import { htmlOptions, isBlockedError } from "../bot/ui.js";
import { translator } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import type { ReminderSender } from "../services/reminderService.js";

/** Sends the daily nudge; reports 403 back so the service can mark the user. */
export function createReminderSender(
  bot: Bot<BotContext>,
  i18n: I18n<BotContext>,
  logger: Logger,
): ReminderSender {
  return {
    async send(user, payload) {
      const t = translator(i18n, user.uiLang);
      const lines = [
        t("reminder-text", {
          due: payload.due,
          new: payload.fresh,
          minutes: payload.minutes,
        }),
      ];
      if (payload.streak > 0) lines.push(t("reminder-streak", { n: payload.streak }));
      try {
        await bot.api.sendMessage(user.tgId, lines.join(" "), {
          ...htmlOptions,
          reply_markup: new InlineKeyboard().text(t("btn-start-learning"), cb(NS.session, "rmd")),
        });
        return "sent";
      } catch (error) {
        if (isBlockedError(error)) return "blocked";
        logger.warn({ err: error, userId: user.id }, "reminder failed");
        return "failed";
      }
    },
  };
}

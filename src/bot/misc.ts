import { type Bot, InlineKeyboard } from "grammy";
import type { BotContext, BotDeps } from "./context.js";
import { cb, NS } from "./keyboards.js";
import { htmlOptions } from "./ui.js";

/** `/help` and the Stars-mandated `/paysupport`; `/pro` itself lives in `pro.ts`. */
export function installMisc(bot: Bot<BotContext>, _deps: BotDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(ctx.t("help-text"), {
      ...htmlOptions,
      reply_markup: new InlineKeyboard().text(ctx.t("btn-menu"), cb(NS.menu)),
    });
  });

  bot.command("paysupport", async (ctx) => {
    await ctx.reply(ctx.t("paysupport-text"), htmlOptions);
  });
}

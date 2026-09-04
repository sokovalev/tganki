import { type Bot, InlineKeyboard } from "grammy";
import { FREE_LIMITS } from "../services/limits.js";
import type { BotContext, BotDeps } from "./context.js";
import { cb, NS } from "./keyboards.js";
import { answer, htmlOptions, show } from "./ui.js";

/** `/help`, `/pro` and the Stars-mandated `/paysupport`. */
export function installMisc(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(ctx.t("help-text"), {
      ...htmlOptions,
      reply_markup: new InlineKeyboard().text(ctx.t("btn-menu"), cb(NS.menu)),
    });
  });

  const pro = async (ctx: BotContext): Promise<void> => {
    deps.events.record(ctx.user.id, "pro_screen", {});
    const text = deps.config.PRO_ENABLED
      ? ctx.t("pro-text", { decks: FREE_LIMITS.ownDecks, notes: FREE_LIMITS.ownNotes })
      : ctx.t("pro-soon");
    await show(ctx, {
      text,
      keyboard: new InlineKeyboard().text(ctx.t("btn-menu"), cb(NS.menu)),
    });
  };

  bot.command("pro", pro);
  bot.callbackQuery("pro", async (ctx) => {
    await answer(ctx);
    await pro(ctx);
  });

  bot.command("paysupport", async (ctx) => {
    await ctx.reply(ctx.t("paysupport-text"), htmlOptions);
  });
}

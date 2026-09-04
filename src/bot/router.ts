import type { Bot } from "grammy";
import type { User } from "../db/schema.js";
import { handleAddInput, handleFreeText } from "./add.js";
import type { BotContext, BotDeps } from "./context.js";
import { handleDeckInput } from "./decks.js";
import { handleOnboardingInput, isOnboarding, showStep } from "./onboarding.js";
import { handleSettingsInput } from "./settings.js";

/** The pending-input token, or null when it is unset or has expired (TTL 10 min). */
export function pendingInput(user: User, now: Date): string | null {
  if (!user.pendingInput) return null;
  if (user.pendingInputExpiresAt && user.pendingInputExpiresAt.getTime() < now.getTime()) {
    return null;
  }
  return user.pendingInput;
}

/**
 * Plain text. A pending question always wins over "add this word" (SPEC §11);
 * during onboarding anything unexpected re-shows the current step.
 */
export function installTextRouter(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply(ctx.t("unknown-command"));
      return;
    }

    const pending = pendingInput(ctx.user, deps.now());
    if (pending) {
      if (await handleOnboardingInput(ctx, deps, pending, text)) return;
      if (await handleSettingsInput(ctx, deps, pending, text)) return;
      if (await handleDeckInput(ctx, deps, pending, text)) return;
      if (await handleAddInput(ctx, deps, pending, text)) return;
    }

    if (isOnboarding(ctx.user)) {
      await ctx.reply(ctx.t("onb-unexpected"));
      await showStep(ctx, deps, ctx.user.onboardingStep ?? "ui_lang");
      return;
    }

    await handleFreeText(ctx, deps, text);
  });
}

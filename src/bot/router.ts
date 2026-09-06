import type { Bot } from "grammy";
import type { User } from "../db/schema.js";
import { handleAddInput, handleFreeText } from "./add.js";
import type { BotContext, BotDeps } from "./context.js";
import { handleDeckInput } from "./decks.js";
import { clearDraft } from "./draft.js";
import { handleExtractInput } from "./extract.js";
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
 * Plain text. A pending question wins over "add this word" (SPEC §11), but only
 * when some feature still owns that question: a state nobody claims is stale —
 * left by an older build, or by a screen that has since been replaced — and it
 * must never swallow the message or answer it with «Ок, ничего не добавляю».
 * We drop it silently and treat the text as a new word. During onboarding
 * anything unexpected re-shows the current step.
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
      if (await handleExtractInput(ctx, deps, pending, text)) return;
      if (await handleAddInput(ctx, deps, pending, text)) return;
      // Unclaimed state: forget it instead of leaving it to intercept the next
      // message too, and let the text fall through as a new word.
      if (ctx.user.pendingInput !== null) await clearDraft(ctx, deps);
    }

    if (isOnboarding(ctx.user)) {
      await ctx.reply(ctx.t("onb-unexpected"));
      await showStep(ctx, deps, ctx.user.onboardingStep ?? "ui_lang");
      return;
    }

    // A forwarded message is read as a text to mine for words, however short
    // it is: nobody forwards an article to add it as one flashcard (§4.3).
    const forwarded = ctx.message.forward_origin !== undefined;
    await handleFreeText(ctx, deps, text, null, { forwarded });
  });
}

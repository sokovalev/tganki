import { GrammyError, type InlineKeyboard } from "grammy";
import type { BotContext } from "./context.js";

export interface Screen {
  text: string;
  keyboard?: InlineKeyboard;
}

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

/** Telegram refuses to edit a message older than 48 hours. */
export const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isGrammyError(error: unknown): error is GrammyError {
  return error instanceof GrammyError;
}

/** "Bad Request: message is not modified" — the render produced identical output. */
export function isNotModified(error: unknown): boolean {
  return isGrammyError(error) && error.description.includes("message is not modified");
}

/** The message is gone or can no longer be edited; send a fresh one instead. */
export function isEditImpossible(error: unknown): boolean {
  if (!isGrammyError(error)) return false;
  const text = error.description.toLowerCase();
  return (
    text.includes("message to edit not found") ||
    text.includes("message can't be edited") ||
    text.includes("message_id_invalid") ||
    text.includes("message identifier is not specified") ||
    text.includes("chat not found")
  );
}

/** 403: the user blocked the bot or deleted the chat. */
export function isBlockedError(error: unknown): boolean {
  return isGrammyError(error) && error.error_code === 403;
}

/** Answers the callback query exactly once; safe to call from every branch. */
export async function answer(ctx: BotContext, text?: string, showAlert = false): Promise<void> {
  if (!ctx.callbackQuery || ctx.answered) return;
  ctx.answered = true;
  try {
    await ctx.answerCallbackQuery(text === undefined ? {} : { text, show_alert: showAlert });
  } catch {
    // "query is too old" — nothing we can do, and nothing worth failing over.
  }
}

/**
 * Renders a screen in place when the update came from a button, and as a new
 * message otherwise.
 */
export async function show(ctx: BotContext, screen: Screen): Promise<void> {
  const options = { ...HTML, ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}) };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(screen.text, options);
      return;
    } catch (error) {
      if (isNotModified(error)) return;
      if (!isEditImpossible(error)) throw error;
    }
  }
  await ctx.reply(screen.text, options);
}

/** Where a message we may want to edit later ended up. */
export interface MessageRef {
  chatId: number;
  messageId: number;
}

/**
 * Sends a screen and remembers where it landed. Used by the «⏳ Подбираю
 * перевод…» placeholder, which is edited into the card preview a second later.
 */
export async function sendTracked(ctx: BotContext, screen: Screen): Promise<MessageRef | null> {
  try {
    const message = await ctx.reply(screen.text, {
      ...HTML,
      ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
    });
    return { chatId: message.chat.id, messageId: message.message_id };
  } catch (error) {
    if (isBlockedError(error)) return null;
    throw error;
  }
}

/**
 * `show`, but it reports where the screen landed so the caller can edit it
 * again later — the «⏳ Подбираю перевод…» placeholder becomes the card
 * preview in place, whether it started as a reply or as an edited screen.
 */
export async function showTracked(ctx: BotContext, screen: Screen): Promise<MessageRef | null> {
  const message = ctx.callbackQuery?.message;
  if (message) {
    const ref = { chatId: message.chat.id, messageId: message.message_id };
    const options = { ...HTML, ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}) };
    try {
      await ctx.editMessageText(screen.text, options);
      return ref;
    } catch (error) {
      if (isNotModified(error)) return ref;
      if (!isEditImpossible(error)) throw error;
    }
  }
  return sendTracked(ctx, screen);
}

/** Edits a message sent earlier in this update; sends a new one if that fails. */
export async function editTracked(
  ctx: BotContext,
  ref: MessageRef | null,
  screen: Screen,
): Promise<void> {
  const options = { ...HTML, ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}) };
  if (ref) {
    try {
      await ctx.api.editMessageText(ref.chatId, ref.messageId, screen.text, options);
      return;
    } catch (error) {
      if (isNotModified(error)) return;
      if (!isEditImpossible(error)) throw error;
    }
  }
  await send(ctx, screen);
}

/** Always a new message (confirmations that should not eat the previous screen). */
export async function send(ctx: BotContext, screen: Screen): Promise<void> {
  await ctx.reply(screen.text, {
    ...HTML,
    ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
  });
}

export const htmlOptions = HTML;

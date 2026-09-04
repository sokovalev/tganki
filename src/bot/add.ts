import { type Bot, InlineKeyboard } from "grammy";
import type { DuplicateNote } from "../db/repos/notes.js";
import { languageTag } from "../i18n/languages.js";
import type { AddPreview, BulkResult, SaveResult } from "../services/addService.js";
import { isAddCandidate, parsePairs } from "../services/addService.js";
import { argInt, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { esc } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { openSession, renderCard, renderSession } from "./session.js";
import { answer, type Screen, send, show } from "./ui.js";

/** Pending-input tokens owned by this feature. */
export const ADD_WORD = "add_word";
export const ADD_BACK = "add_back";

function personalTitle(ctx: BotContext): string {
  return ctx.t("deck-personal", { lang: languageTag(ctx.user.langFrom ?? "en") });
}

function askScreen(ctx: BotContext, front: string, deckTitle: string): Screen {
  const t = ctx.t.bind(ctx);
  return {
    text: [
      t("add-ask-translation", { word: esc(front) }),
      t("add-ask-hint"),
      t("add-target-deck", { deck: esc(deckTitle) }),
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text(t("btn-cancel"), cb(NS.add, "cancel"))
      .text(t("btn-other-deck"), cb(NS.add, "decks")),
  };
}

function duplicateScreen(ctx: BotContext, duplicate: DuplicateNote, own: boolean): Screen {
  const t = ctx.t.bind(ctx);
  if (own) {
    return {
      text: t("add-duplicate-own", {
        deck: esc(duplicate.deckTitle),
        word: esc(duplicate.front),
        translation: esc(duplicate.back),
      }),
      keyboard: new InlineKeyboard().text(t("btn-add-anyway"), cb(NS.add, "force")),
    };
  }
  return {
    text: t("add-duplicate-builtin", {
      deck: esc(duplicate.deckTitle),
      position: duplicate.position,
      word: esc(duplicate.front),
      translation: esc(duplicate.back),
    }),
    keyboard: new InlineKeyboard()
      .text(t("btn-learn-now"), cb(NS.add, "now", duplicate.noteId))
      .row()
      .text(t("btn-add-anyway"), cb(NS.add, "force")),
  };
}

function limitScreen(ctx: BotContext, limit: number): Screen {
  return {
    text: ctx.t("add-limit-notes", { limit }),
    keyboard: new InlineKeyboard().text(ctx.t("btn-pro"), cb(NS.pro)),
  };
}

function addedScreen(ctx: BotContext, result: Extract<SaveResult, { kind: "added" }>): Screen {
  const t = ctx.t.bind(ctx);
  return {
    text: t("add-done", {
      deck: esc(result.deck.title),
      word: esc(result.note.front),
      translation: esc(result.note.back),
    }),
    keyboard: new InlineKeyboard()
      .text(t("btn-add-more"), cb(NS.add, "start"))
      .text(t("btn-menu"), cb(NS.menu)),
  };
}

function bulkScreen(ctx: BotContext, result: Extract<BulkResult, { kind: "added" }>): Screen {
  const t = ctx.t.bind(ctx);
  const lines = [t("add-bulk-done", { added: result.added, skipped: result.skipped })];
  if (result.invalid > 0) lines.push(t("add-bulk-invalid", { n: result.invalid }));
  lines.push(t("add-target-deck", { deck: esc(result.deck.title) }));
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard()
      .text(t("btn-add-more"), cb(NS.add, "start"))
      .text(t("btn-menu"), cb(NS.menu)),
  };
}

async function renderPreview(
  ctx: BotContext,
  deps: BotDeps,
  preview: AddPreview,
  front: string,
): Promise<void> {
  if (preview.kind === "limit") {
    await show(ctx, limitScreen(ctx, preview.check.limit));
    return;
  }
  if (preview.kind === "duplicate") {
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    ctx.setUser(await deps.repos.users.update(ctx.user.id, { pendingPayload: { front } }));
    await show(ctx, duplicateScreen(ctx, preview.duplicate, preview.own));
    return;
  }
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, ADD_BACK, {
      now: deps.now(),
      payload: { front: preview.front, deckId: preview.deck.id },
    }),
  );
  await show(ctx, askScreen(ctx, preview.front, preview.deck.title));
}

/** `word - перевод` (one line or many) — no extra question needed. */
async function saveDirect(ctx: BotContext, deps: BotDeps, text: string): Promise<boolean> {
  const parsed = parsePairs(text);
  if (parsed.pairs.length === 0) return false;
  const deckId = ctx.user.pendingPayload?.deckId ?? null;

  if (parsed.pairs.length === 1) {
    const pair = parsed.pairs[0]!;
    const result = await deps.add.save({
      user: ctx.user,
      front: pair.front,
      back: pair.back,
      deckId,
      personalTitle: personalTitle(ctx),
      now: deps.now(),
    });
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    if (result.kind === "limit") {
      await send(ctx, limitScreen(ctx, result.check.limit));
      return true;
    }
    if (result.kind === "duplicate") {
      await send(
        ctx,
        duplicateScreen(ctx, result.duplicate, result.duplicate.deckOwnerId !== null),
      );
      return true;
    }
    deps.events.record(ctx.user.id, "word_added", { deckId: result.deck.id, via: "inline" });
    await send(ctx, addedScreen(ctx, result));
    return true;
  }

  const result = await deps.add.saveMany({
    user: ctx.user,
    pairs: parsed.pairs,
    invalid: parsed.invalid,
    deckId,
    personalTitle: personalTitle(ctx),
    now: deps.now(),
  });
  ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
  if (result.kind === "limit") {
    await send(ctx, limitScreen(ctx, result.check.limit));
    return true;
  }
  deps.events.record(ctx.user.id, "word_added", { deckId: result.deck.id, count: result.added });
  await send(ctx, bulkScreen(ctx, result));
  return true;
}

/**
 * Free text that is not a pending answer: `word - перевод` saves straight
 * away, a short bare word asks for the translation, anything longer gets a hint.
 */
export async function handleFreeText(ctx: BotContext, deps: BotDeps, text: string): Promise<void> {
  if (await saveDirect(ctx, deps, text)) return;
  if (!isAddCandidate(text)) {
    await send(ctx, { text: ctx.t("add-too-long") });
    return;
  }
  const preview = await deps.add.preview({
    user: ctx.user,
    text,
    deckId: ctx.user.pendingPayload?.deckId ?? null,
    personalTitle: personalTitle(ctx),
    now: deps.now(),
  });
  await renderPreview(ctx, deps, preview, text.trim());
}

/** Text that answers a question this feature asked. Returns true when consumed. */
export async function handleAddInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending === ADD_WORD) {
    await handleFreeText(ctx, deps, text);
    return true;
  }
  if (pending !== ADD_BACK) return false;

  const front = ctx.user.pendingPayload?.front;
  const deckId = ctx.user.pendingPayload?.deckId ?? null;
  if (!front) {
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    return false;
  }
  const result = await deps.add.save({
    user: ctx.user,
    front,
    back: text,
    deckId,
    personalTitle: personalTitle(ctx),
    now: deps.now(),
  });
  ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
  if (result.kind === "limit") {
    await send(ctx, limitScreen(ctx, result.check.limit));
    return true;
  }
  if (result.kind === "duplicate") {
    await send(ctx, duplicateScreen(ctx, result.duplicate, result.duplicate.deckOwnerId !== null));
    return true;
  }
  deps.events.record(ctx.user.id, "word_added", { deckId: result.deck.id, via: "ask" });
  await send(ctx, addedScreen(ctx, result));
  return true;
}

async function promptForWord(
  ctx: BotContext,
  deps: BotDeps,
  deckId?: number | null,
): Promise<void> {
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, ADD_WORD, {
      now: deps.now(),
      ...(deckId !== undefined && deckId !== null ? { payload: { deckId } } : {}),
    }),
  );
  await show(ctx, {
    text: [ctx.t("add-prompt"), ctx.t("add-ask-hint")].join("\n"),
    keyboard: new InlineKeyboard()
      .text(ctx.t("btn-cancel"), cb(NS.add, "cancel"))
      .text(ctx.t("btn-other-deck"), cb(NS.add, "decks")),
  });
}

export function installAdd(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("add", async (ctx) => {
    await promptForWord(ctx, deps);
  });

  bot.callbackQuery("a:start", async (ctx) => {
    await answer(ctx);
    await promptForWord(ctx, deps);
  });

  bot.callbackQuery("a:cancel", async (ctx) => {
    await answer(ctx, ctx.t("toast-cancelled"));
    ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
    await show(ctx, { text: ctx.t("add-cancelled") });
  });

  bot.callbackQuery("a:force", async (ctx) => {
    await answer(ctx);
    const front = ctx.user.pendingPayload?.front;
    if (!front) return show(ctx, { text: ctx.t("add-expired") });
    const deck = await deps.add.resolveDeck(ctx.user, null, personalTitle(ctx));
    ctx.setUser(
      await deps.repos.users.setPendingInput(ctx.user.id, ADD_BACK, {
        now: deps.now(),
        payload: { front, deckId: deck.id },
      }),
    );
    await show(ctx, askScreen(ctx, front, deck.title));
  });

  bot.callbackQuery(/^a:now:/u, async (ctx) => {
    await answer(ctx);
    const noteId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (noteId === null) return;
    const cardId = await deps.repos.cards.createCard({
      userId: ctx.user.id,
      noteId,
      mode: "recognition",
      due: deps.now(),
    });
    const view = await deps.sessions.startWith({
      user: ctx.user,
      chatId: ctx.chat?.id ?? ctx.user.tgId,
      deckId: null,
      cardIds: [cardId],
      now: deps.now(),
    });
    if (view) await renderSession(ctx, deps, view.session, renderCard(ctx.t.bind(ctx), view));
    else await openSession(ctx, deps);
  });

  bot.callbackQuery("a:decks", async (ctx) => {
    await answer(ctx);
    const decks = await deps.add.listOwnDecks(ctx.user.id);
    const keyboard = new InlineKeyboard();
    for (const deck of decks) {
      keyboard.text(deck.title, cb(NS.add, "deck", deck.id)).row();
    }
    keyboard.text(ctx.t("btn-cancel"), cb(NS.add, "cancel"));
    await show(ctx, { text: ctx.t("add-choose-deck"), keyboard });
  });

  bot.callbackQuery(/^a:deck:/u, async (ctx) => {
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    const front = ctx.user.pendingPayload?.front;
    if (front) {
      const deck = await deps.repos.decks.findById(deckId);
      ctx.setUser(
        await deps.repos.users.setPendingInput(ctx.user.id, ADD_BACK, {
          now: deps.now(),
          payload: { front, deckId },
        }),
      );
      await show(ctx, askScreen(ctx, front, deck?.title ?? ""));
      return;
    }
    await promptForWord(ctx, deps, deckId);
  });
}

/** Exported for the router: which pending tokens this feature owns. */
export function ownsPendingInput(pending: string): boolean {
  return pending === ADD_WORD || pending === ADD_BACK;
}

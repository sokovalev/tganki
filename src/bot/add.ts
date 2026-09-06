import { type Bot, InlineKeyboard } from "grammy";
import type { DuplicateNote } from "../db/repos/notes.js";
import type { Deck, Note, PendingCard } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import type { GeneratedCard } from "../llm/types.js";
import type { AddPreview, AskReason, BulkResult, SaveResult } from "../services/addService.js";
import { isAddCandidate, parsePairs } from "../services/addService.js";
import { stripUrls } from "../services/extractService.js";
import { FREE_LIMITS } from "../services/limits.js";
import { argInt, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import {
  clearDraft,
  freshRev,
  nextRev,
  personalTitle,
  saveDraft,
  saveDraftAsking,
} from "./draft.js";
import { runExtraction } from "./extract.js";
import { bold, esc, italic } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { openSession, renderCard, renderSession } from "./session.js";
import { answer, editTracked, type Screen, send, show, showTracked } from "./ui.js";

/** Pending-input tokens owned by this feature. */
export const ADD_WORD = "add_word";
export const ADD_BACK = "add_back";

/**
 * State machine of the add flow (SPEC §4.1, §4.1a, §11). `pending_input` says
 * what a *text* message means; `pending_payload` carries the draft the buttons
 * currently on screen act on. The two are deliberately independent: a screen
 * with buttons is not a question.
 *
 * | pending_input | payload                   | a text message means                              | buttons |
 * |---------------|---------------------------|---------------------------------------------------|---------|
 * | null          | the draft, if any         | a new word, a `слово - перевод` pair, or a text (§4.3) | ➕ Добавить / ✏️ Свой перевод / 📚 Другая дека / ➕ Добавить всё равно / ▶️ Учить сейчас — all act on the payload |
 * | add_word      | { rev, deckId? }          | the word to add (pairs still win)                  | ✖ Отмена, 📚 Другая дека |
 * | add_back      | { rev, front, deckId?, card? } | the translation for `front` — unless it parses as `слово - перевод`, which wins | ✖ Отмена, 📚 Другая дека |
 * | anything else | —                         | not ours: the router drops the state and the text becomes a new word | — |
 *
 * Three rules keep screens and state in sync:
 * - every screen that parks a draft (the generated preview, the duplicate
 *   screen) goes through `saveDraft`, which clears `pending_input`: the
 *   next message is a new word, never an answer to a question nobody asked;
 * - free text is never routed into a state that is not in the table above;
 * - every draft carries a revision and every button repeats it, so a tap on a
 *   screen the user has since moved past changes nothing (`src/bot/draft.ts`).
 */

/** Only the fields a preview needs; `pos` is shown but never stored on a note. */
export function toPendingCard(card: GeneratedCard): PendingCard {
  return {
    front: card.front,
    back: card.back,
    transcription: card.transcription,
    example: card.example,
    exampleTr: card.exampleTr,
    pos: card.pos,
  };
}

/** A typed pair, in the shape the preview and «Добавить всё равно» expect. */
function manualCard(front: string, back: string): PendingCard {
  return { front, back, transcription: "", example: "", exampleTr: "", pos: "" };
}

export function askScreen(
  t: Translate,
  input: { front: string; deckTitle: string; rev: number; reason?: AskReason },
): Screen {
  const lines: string[] = [];
  if (input.reason === "failed") lines.push(t("add-generate-failed"));
  if (input.reason === "limit") {
    lines.push(t("add-generate-limit", { limit: FREE_LIMITS.generationsPerDay }));
  }
  lines.push(
    t("add-ask-translation", { word: esc(input.front) }),
    t("add-ask-hint"),
    t("add-target-deck", { deck: esc(input.deckTitle) }),
  );
  const keyboard = new InlineKeyboard()
    .text(t("btn-cancel"), cb(NS.add, "cancel", input.rev))
    .text(t("btn-other-deck"), cb(NS.add, "decks", input.rev));
  // Every 🔒 has to lead somewhere (SPEC §9.1): a spent daily budget is one.
  if (input.reason === "limit") keyboard.row().text(t("btn-pro"), cb(NS.pro));
  return { text: lines.join("\n"), keyboard };
}

/** "прил." / "adj." — empty for a part of speech we have no short label for. */
function posLabel(t: Translate, pos: string): string {
  return t("pos-label", { pos }).trim();
}

/** The generated card, waiting for a tap (SPEC §4.1a). */
export function renderGenerated(
  t: Translate,
  input: { card: PendingCard; deckTitle: string; rev: number },
): Screen {
  const { card } = input;
  const meta = [
    card.transcription ? italic(`/${esc(card.transcription)}/`) : "",
    posLabel(t, card.pos),
  ].filter((part) => part !== "");
  const lines = [
    meta.length > 0 ? `${bold(esc(card.front))}  ${meta.join(" · ")}` : bold(esc(card.front)),
  ];
  if (card.back) lines.push(esc(card.back));
  if (card.example) {
    lines.push(
      italic(
        card.exampleTr
          ? t("add-example-line", { example: esc(card.example), exampleTr: esc(card.exampleTr) })
          : esc(card.example),
      ),
    );
  }
  lines.push(t("add-target-deck", { deck: esc(input.deckTitle) }));
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard()
      .text(t("btn-add-generated"), cb(NS.add, "g", input.rev))
      .text(t("btn-other-deck"), cb(NS.add, "decks", input.rev))
      .row()
      .text(t("btn-own-translation"), cb(NS.add, "own", input.rev))
      .text(t("btn-close"), cb(NS.add, "cancel", input.rev)),
  };
}

function duplicateScreen(
  t: Translate,
  duplicate: DuplicateNote,
  own: boolean,
  rev: number,
): Screen {
  if (own) {
    return {
      text: t("add-duplicate-own", {
        deck: esc(duplicate.deckTitle),
        word: esc(duplicate.front),
        translation: esc(duplicate.back),
      }),
      keyboard: new InlineKeyboard().text(t("btn-add-anyway"), cb(NS.add, "force", rev)),
    };
  }
  return {
    text: t("add-duplicate-builtin", {
      deck: esc(duplicate.deckTitle),
      word: esc(duplicate.front),
      translation: esc(duplicate.back),
    }),
    keyboard: new InlineKeyboard()
      .text(t("btn-learn-now"), cb(NS.add, "now", rev, duplicate.noteId))
      .row()
      .text(t("btn-add-anyway"), cb(NS.add, "force", rev)),
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

/** Records what one generation cost us, cache hits included (SPEC §12). */
function recordGenerated(
  ctx: BotContext,
  deps: BotDeps,
  meta: { cached: boolean; latencyMs: number },
  via?: string,
): void {
  deps.events.record(ctx.user.id, "word_generated", {
    cached: meta.cached,
    latencyMs: meta.latencyMs,
    model: deps.add.llm?.model ?? null,
    langFrom: ctx.user.langFrom ?? "en",
    langTo: ctx.user.langTo ?? ctx.user.uiLang,
    ...(via ? { via } : {}),
  });
}

/**
 * §4.1a: «⏳ Подбираю перевод…» goes out first, the same message is then edited
 * into the card preview — or, when the model fails, into the manual question.
 */
async function generateAndShow(
  ctx: BotContext,
  deps: BotDeps,
  front: string,
  deck: Deck,
  rev: number,
  options: { force?: boolean } = {},
): Promise<void> {
  const t = ctx.t.bind(ctx);
  const force = options.force ?? false;
  const ref = await showTracked(ctx, { text: t("add-generating") });
  const result = await deps.add.generate({ user: ctx.user, text: front, now: deps.now() });

  if (result.kind === "generated" || result.kind === "duplicate") {
    if (result.kind === "generated") recordGenerated(ctx, deps, result);
    const card = toPendingCard(result.card);
    // The canonical form may already be in a deck — «неохотный» resolved to a
    // "reluctant" the user has. The card is parked either way, so «Добавить
    // всё равно» shows it instead of falling back to the manual question.
    const duplicate = result.kind === "duplicate" && !force;
    await saveDraft(ctx, deps, rev, {
      front: card.front,
      deckId: deck.id,
      card,
      ...(force ? { force: true } : {}),
    });
    await editTracked(
      ctx,
      ref,
      duplicate
        ? duplicateScreen(t, result.duplicate, result.own, rev)
        : renderGenerated(t, { card, deckTitle: deck.title, rev }),
    );
    return;
  }

  deps.events.record(ctx.user.id, "word_generation_failed", { reason: result.reason });
  await saveDraftAsking(ctx, deps, ADD_BACK, rev, {
    front,
    deckId: deck.id,
    ...(force ? { force: true } : {}),
  });
  await editTracked(
    ctx,
    ref,
    askScreen(t, { front, deckTitle: deck.title, rev, reason: "failed" }),
  );
}

async function renderPreview(
  ctx: BotContext,
  deps: BotDeps,
  preview: AddPreview,
  front: string,
  deckId: number | null,
  rev: number,
): Promise<void> {
  const t = ctx.t.bind(ctx);
  if (preview.kind === "limit") {
    await show(ctx, limitScreen(ctx, preview.check.limit));
    return;
  }
  if (preview.kind === "duplicate") {
    // No card yet: the word the user typed is already known, so the model has
    // not run. «Добавить всё равно» picks the flow back up from here.
    await saveDraft(ctx, deps, rev, { front, deckId });
    await show(ctx, duplicateScreen(t, preview.duplicate, preview.own, rev));
    return;
  }
  if (preview.kind === "generate") {
    await generateAndShow(ctx, deps, preview.front, preview.deck, rev);
    return;
  }
  await saveDraftAsking(ctx, deps, ADD_BACK, rev, {
    front: preview.front,
    deckId: preview.deck.id,
  });
  await show(
    ctx,
    askScreen(t, {
      front: preview.front,
      deckTitle: preview.deck.title,
      rev,
      ...(preview.reason ? { reason: preview.reason } : {}),
    }),
  );
}

/**
 * Fills the transcription and the example of a freshly typed pair in the
 * background (SPEC §4.1a). Fire and forget: the user already has their card.
 */
function enrichLater(ctx: BotContext, deps: BotDeps, note: Note): void {
  if (!deps.add.llm) return;
  const user = ctx.user;
  void deps.add
    .enrich({ user, noteId: note.id, front: note.front, now: deps.now() })
    .then((result) => {
      if (result) recordGenerated(ctx, deps, result, "enrich");
    })
    .catch((error: unknown) => {
      deps.logger.debug({ err: error, noteId: note.id }, "background enrichment failed");
    });
}

/** `word - перевод` (one line or many) — no extra question needed. */
async function saveDirect(
  ctx: BotContext,
  deps: BotDeps,
  text: string,
  deckId: number | null,
  rev: number,
): Promise<boolean> {
  const parsed = parsePairs(text);
  if (parsed.pairs.length === 0) return false;
  const t = ctx.t.bind(ctx);

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
    await clearDraft(ctx, deps);
    if (result.kind === "limit") {
      await send(ctx, limitScreen(ctx, result.check.limit));
      return true;
    }
    if (result.kind === "duplicate") {
      // The pair is kept as a draft so «Добавить всё равно» can still save it.
      await saveDraft(ctx, deps, rev, {
        front: pair.front,
        deckId,
        card: manualCard(pair.front, pair.back),
      });
      await send(
        ctx,
        duplicateScreen(t, result.duplicate, result.duplicate.deckOwnerId !== null, rev),
      );
      return true;
    }
    deps.events.record(ctx.user.id, "word_added", { deckId: result.deck.id, via: "inline" });
    enrichLater(ctx, deps, result.note);
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
  await clearDraft(ctx, deps);
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
 * away, a short bare word gets an AI-filled preview (or, without a key, the
 * manual question), and anything longer — or anything forwarded — is read as a
 * text to find words in (SPEC §4.3).
 */
export async function handleFreeText(
  ctx: BotContext,
  deps: BotDeps,
  text: string,
  /** Only set while a deck is actually pending («📚 Другая дека» → «Какое слово?»). */
  deckId: number | null = null,
  options: { forwarded?: boolean } = {},
): Promise<void> {
  const rev = nextRev(ctx.user);
  if (await saveDirect(ctx, deps, text, deckId, rev)) return;
  // Links carry no vocabulary; what is left decides whether this is a word.
  const stripped = stripUrls(text);
  if (!options.forwarded && isAddCandidate(stripped)) {
    const preview = await deps.add.preview({
      user: ctx.user,
      text: stripped,
      deckId,
      personalTitle: personalTitle(ctx),
      now: deps.now(),
      generate: true,
    });
    await renderPreview(ctx, deps, preview, stripped.trim(), deckId, rev);
    return;
  }
  await runExtraction(ctx, deps, stripped, { deckId });
}

/** Text that answers a question this feature asked. Returns true when consumed. */
export async function handleAddInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending === ADD_WORD) {
    await handleFreeText(ctx, deps, text, ctx.user.pendingPayload?.deckId ?? null);
    return true;
  }
  if (pending !== ADD_BACK) return false;

  const payload = ctx.user.pendingPayload;
  const front = payload?.front;
  const deckId = payload?.deckId ?? null;
  if (!front) {
    await clearDraft(ctx, deps);
    return false;
  }
  // The question itself says «можно сразу парой: слово - перевод», so a pair
  // is a new word, not the translation of the word we asked about.
  if (parsePairs(text).pairs.length > 0) {
    await clearDraft(ctx, deps);
    await handleFreeText(ctx, deps, text, deckId);
    return true;
  }
  // «Свой перевод»: the user's wording wins, the generated transcription and
  // example are kept — they belong to the same word.
  const card = payload?.card?.front === front ? payload.card : undefined;
  const rev = nextRev(ctx.user);
  const result = await deps.add.save({
    user: ctx.user,
    front,
    back: text,
    deckId,
    personalTitle: personalTitle(ctx),
    now: deps.now(),
    ...(payload?.force ? { force: true } : {}),
    ...(card
      ? {
          transcription: card.transcription,
          example: card.example,
          exampleTr: card.exampleTr,
        }
      : {}),
  });
  await clearDraft(ctx, deps);
  if (result.kind === "limit") {
    await send(ctx, limitScreen(ctx, result.check.limit));
    return true;
  }
  if (result.kind === "duplicate") {
    await saveDraft(ctx, deps, rev, {
      front,
      deckId,
      card: card ? { ...card, back: text.trim() } : manualCard(front, text.trim()),
    });
    await send(
      ctx,
      duplicateScreen(
        ctx.t.bind(ctx),
        result.duplicate,
        result.duplicate.deckOwnerId !== null,
        rev,
      ),
    );
    return true;
  }
  deps.events.record(ctx.user.id, "word_added", {
    deckId: result.deck.id,
    via: card ? "generated_own" : "ask",
  });
  if (!card) enrichLater(ctx, deps, result.note);
  await send(ctx, addedScreen(ctx, result));
  return true;
}

async function promptForWord(
  ctx: BotContext,
  deps: BotDeps,
  deckId?: number | null,
): Promise<void> {
  const rev = nextRev(ctx.user);
  await saveDraftAsking(ctx, deps, ADD_WORD, rev, {
    ...(deckId !== undefined && deckId !== null ? { deckId } : {}),
  });
  await show(ctx, {
    text: [ctx.t("add-prompt"), ctx.t("add-ask-hint")].join("\n"),
    keyboard: new InlineKeyboard()
      .text(ctx.t("btn-cancel"), cb(NS.add, "cancel", rev))
      .text(ctx.t("btn-other-deck"), cb(NS.add, "decks", rev)),
  });
}

/**
 * Every button of this feature is matched with `(?::|$)`, so a keyboard left on
 * screen by an older build — one whose callbacks carry no revision at all —
 * still reaches its handler and gets the «это старое сообщение» toast instead
 * of silently doing nothing.
 */
export function installAdd(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("add", async (ctx) => {
    await promptForWord(ctx, deps);
  });

  bot.callbackQuery("a:start", async (ctx) => {
    await answer(ctx);
    await promptForWord(ctx, deps);
  });

  bot.callbackQuery(/^a:cancel(?::|$)/u, async (ctx) => {
    if ((await freshRev(ctx, ctx.callbackQuery.data)) === null) return;
    await answer(ctx, ctx.t("toast-cancelled"));
    await clearDraft(ctx, deps);
    await show(ctx, { text: ctx.t("add-cancelled") });
  });

  /** «➕ Добавить всё равно» under a duplicate screen. */
  bot.callbackQuery(/^a:force(?::|$)/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const payload = ctx.user.pendingPayload;
    const front = payload?.front;
    if (!front) return show(ctx, { text: ctx.t("add-expired") });
    const t = ctx.t.bind(ctx);
    const deck = await deps.add.resolveDeck(ctx.user, payload?.deckId ?? null, personalTitle(ctx));
    const card = payload?.card;
    // The card is already there (generated, or typed as `слово - перевод`):
    // show it, so the user sees what «➕ Добавить» is about to save.
    if (card) {
      await saveDraft(ctx, deps, rev, {
        front: card.front,
        deckId: deck.id,
        card,
        force: true,
      });
      await show(ctx, renderGenerated(t, { card, deckTitle: deck.title, rev }));
      return;
    }
    // The duplicate was found on the typed word, before the model ran. The
    // user wants the word anyway, so continue into §4.1a instead of asking.
    if (deps.add.llm) {
      await generateAndShow(ctx, deps, front, deck, rev, { force: true });
      return;
    }
    await saveDraftAsking(ctx, deps, ADD_BACK, rev, {
      front,
      deckId: deck.id,
      force: true,
    });
    await show(ctx, askScreen(t, { front, deckTitle: deck.title, rev }));
  });

  /** «➕ Добавить» under a generated preview. */
  bot.callbackQuery(/^a:g(?::|$)/u, async (ctx) => {
    if ((await freshRev(ctx, ctx.callbackQuery.data)) === null) return;
    await answer(ctx);
    const payload = ctx.user.pendingPayload;
    const card = payload?.card;
    if (!card) return show(ctx, { text: ctx.t("add-expired") });
    const result = await deps.add.save({
      user: ctx.user,
      front: card.front,
      back: card.back,
      transcription: card.transcription,
      example: card.example,
      exampleTr: card.exampleTr,
      deckId: payload?.deckId ?? null,
      personalTitle: personalTitle(ctx),
      now: deps.now(),
      // Already past the duplicate screen — asking again would be a dead end.
      ...(payload.force ? { force: true } : {}),
    });
    const rev = nextRev(ctx.user);
    await clearDraft(ctx, deps);
    if (result.kind === "limit") return show(ctx, limitScreen(ctx, result.check.limit));
    if (result.kind === "duplicate") {
      await saveDraft(ctx, deps, rev, { front: card.front, deckId: payload?.deckId ?? null, card });
      return show(
        ctx,
        duplicateScreen(
          ctx.t.bind(ctx),
          result.duplicate,
          result.duplicate.deckOwnerId !== null,
          rev,
        ),
      );
    }
    deps.events.record(ctx.user.id, "word_added", { deckId: result.deck.id, via: "generated" });
    await show(ctx, addedScreen(ctx, result));
  });

  /** «✏️ Свой перевод»: keep the generated extras, ask for the translation. */
  bot.callbackQuery(/^a:own(?::|$)/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const payload = ctx.user.pendingPayload;
    const card = payload?.card;
    if (!card) return show(ctx, { text: ctx.t("add-expired") });
    const deck = await deps.add.resolveDeck(ctx.user, payload?.deckId ?? null, personalTitle(ctx));
    await saveDraftAsking(ctx, deps, ADD_BACK, rev, {
      front: card.front,
      deckId: deck.id,
      card,
      ...(payload.force ? { force: true } : {}),
    });
    await show(ctx, askScreen(ctx.t.bind(ctx), { front: card.front, deckTitle: deck.title, rev }));
  });

  bot.callbackQuery(/^a:now(?::|$)/u, async (ctx) => {
    if ((await freshRev(ctx, ctx.callbackQuery.data)) === null) return;
    await answer(ctx);
    const noteId = argInt(parseCallback(ctx.callbackQuery.data)!, 1);
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

  bot.callbackQuery(/^a:decks(?::|$)/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const decks = await deps.add.listOwnDecks(ctx.user.id);
    const keyboard = new InlineKeyboard();
    for (const deck of decks) {
      keyboard.text(deck.title, cb(NS.add, "deck", rev, deck.id)).row();
    }
    keyboard.text(ctx.t("btn-cancel"), cb(NS.add, "cancel", rev));
    await show(ctx, { text: ctx.t("add-choose-deck"), keyboard });
  });

  bot.callbackQuery(/^a:deck(?::|$)/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 1);
    if (deckId === null) return;
    const payload = ctx.user.pendingPayload;
    const front = payload?.front;
    const t = ctx.t.bind(ctx);
    if (front) {
      const deck = await deps.repos.decks.findById(deckId);
      const card = payload?.card;
      // A card in the payload means a preview is on screen — unless the user
      // already asked for «Свой перевод», in which case we are back to the
      // question and only the target deck is changing.
      const force = payload?.force ?? false;
      if (card && ctx.user.pendingInput !== ADD_BACK) {
        await saveDraft(ctx, deps, rev, { front, deckId, card, ...(force ? { force } : {}) });
        await show(ctx, renderGenerated(t, { card, deckTitle: deck?.title ?? "", rev }));
        return;
      }
      await saveDraftAsking(ctx, deps, ADD_BACK, rev, {
        front,
        deckId,
        ...(card ? { card } : {}),
        ...(force ? { force } : {}),
      });
      await show(ctx, askScreen(t, { front, deckTitle: deck?.title ?? "", rev }));
      return;
    }
    await promptForWord(ctx, deps, deckId);
  });
}

/** Exported for the router: which pending tokens this feature owns. */
export function ownsPendingInput(pending: string): boolean {
  return pending === ADD_WORD || pending === ADD_BACK;
}

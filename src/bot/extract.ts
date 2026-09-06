/**
 * «Слова из текста» (SPEC §4.3).
 *
 * A message that is too long to be a word — or a forwarded one, or a text sent
 * after `/extract` — goes to the model, which names the words the user is
 * unlikely to know. What is left after dropping everything they already learn
 * becomes a checklist; the ticked lines turn into full cards through the same
 * cached generator as §4.1a.
 *
 * | pending_input | payload                | a text message means            | buttons |
 * |---------------|------------------------|---------------------------------|---------|
 * | extract_text  | { rev, deckId? }       | the text to look through        | ✖ Отмена |
 * | null          | { rev, extract }       | a new word / a new text         | the checklist |
 * | null          | { rev, learn: [ids] }  | a new word / a new text         | ▶️ Учить новые |
 *
 * Every button carries the draft revision (`src/bot/draft.ts`), so a checklist
 * from an older message can never tick the boxes of the current one.
 */

import { type Bot, InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { PendingExtractWord } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import { getLanguage, languageName } from "../i18n/languages.js";
import { hasLetters, MAX_EXTRACT_CHARS, stripUrls } from "../services/extractService.js";
import { FREE_LIMITS } from "../services/limits.js";
import { argInt, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { clearDraft, freshRev, nextRev, personalTitle, saveDraft } from "./draft.js";
import { bold, esc } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { openSession, renderCard, renderSession } from "./session.js";
import { answer, editTracked, type Screen, show, showTracked } from "./ui.js";

/** Pending-input token owned by this feature. */
export const EXTRACT_TEXT = "extract_text";

/** Checkboxes per row on the checklist. */
const PER_ROW = 5;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/** «📝 Пришли текст…» — the screen `/extract` and the menu button show. */
export function askTextScreen(t: Translate, rev: number): Screen {
  return {
    text: t("extract-ask"),
    keyboard: new InlineKeyboard().text(t("btn-cancel"), cb(NS.extract, "cancel", rev)),
  };
}

export interface ChecklistInput {
  words: readonly PendingExtractWord[];
  /** How many of the words found are already known — shown, never listed. */
  dropped: number;
  deckTitle: string;
  truncated?: boolean;
  rev: number;
}

/** The checklist: `1. слово — перевод` plus a checkbox per line (SPEC §4.3). */
export function renderChecklist(t: Translate, input: ChecklistInput): Screen {
  const lines: string[] = [];
  if (input.truncated) lines.push(t("extract-truncated", { n: MAX_EXTRACT_CHARS }));
  lines.push(t("extract-found", { n: input.words.length }));
  if (input.dropped > 0) lines.push(t("extract-dropped", { n: input.dropped }));
  for (const [index, word] of input.words.entries()) {
    lines.push(`${index + 1}. ${bold(esc(word.front))} — ${esc(word.back)}`);
  }
  lines.push(t("add-target-deck", { deck: esc(input.deckTitle) }));

  const selected = input.words.filter((word) => word.on).length;
  const keyboard = new InlineKeyboard();
  const toggles: InlineKeyboardButton[] = input.words.map((word, index) =>
    InlineKeyboard.text(
      `${word.on ? "☑" : "☐"} ${index + 1}`,
      cb(NS.extract, "t", input.rev, index),
    ),
  );
  for (const row of chunk(toggles, PER_ROW)) keyboard.row(...row);
  keyboard.row(
    InlineKeyboard.text(t("btn-extract-add", { n: selected }), cb(NS.extract, "add", input.rev)),
  );
  keyboard.row(
    InlineKeyboard.text(t("btn-select-all"), cb(NS.extract, "all", input.rev)),
    InlineKeyboard.text(t("btn-select-none"), cb(NS.extract, "none", input.rev)),
  );
  keyboard.row(
    InlineKeyboard.text(t("btn-other-deck"), cb(NS.extract, "decks", input.rev)),
    InlineKeyboard.text(t("btn-close"), cb(NS.extract, "cancel", input.rev)),
  );
  return { text: lines.join("\n"), keyboard };
}

export interface SummaryInput {
  deckTitle: string;
  added: ReadonlyArray<{ front: string; back: string }>;
  skipped: number;
  budgetSkipped: number;
  /** Set when the Free note budget cut the batch short (SPEC §9.1). */
  noteLimit?: number;
  rev: number;
}

/** «✅ Добавил 7 слов в «Мои слова · KA»: …» (SPEC §4.3). */
export function renderExtractSummary(t: Translate, input: SummaryInput): Screen {
  const words = input.added
    .map((word) => `${bold(esc(word.front))} — ${esc(word.back)}`)
    .join(", ");
  const lines = [
    input.added.length > 0
      ? t("extract-added", { n: input.added.length, deck: esc(input.deckTitle), words })
      : t("extract-added-none"),
  ];
  if (input.skipped > 0) lines.push(t("extract-skipped", { n: input.skipped }));
  if (input.budgetSkipped > 0) {
    lines.push(t("extract-budget-skipped", { n: input.budgetSkipped }));
  }
  if (input.noteLimit !== undefined) lines.push(t("add-limit-notes", { limit: input.noteLimit }));
  const keyboard = new InlineKeyboard();
  if (input.added.length > 0) {
    keyboard.text(t("btn-learn-new"), cb(NS.extract, "learn", input.rev));
  }
  keyboard.text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

/** The words found in a text, all ticked (SPEC §4.3 "All selected by default"). */
function toPendingWords(
  words: ReadonlyArray<{ front: string; back: string; inText: string }>,
): PendingExtractWord[] {
  return words.map((word) => ({
    front: word.front,
    back: word.back,
    ...(word.inText ? { inText: word.inText } : {}),
    on: true,
  }));
}

/**
 * The whole §4.3 flow for one text: «🔎 Ищу незнакомые слова…» goes out first
 * and every outcome is edited into that same message.
 */
export async function runExtraction(
  ctx: BotContext,
  deps: BotDeps,
  text: string,
  options: { deckId?: number | null } = {},
): Promise<void> {
  const t = ctx.t.bind(ctx);
  if (!deps.extract.llm) {
    await show(ctx, { text: t("extract-no-llm") });
    return;
  }
  // A message that is only links or emoji has nothing to look through.
  if (!hasLetters(stripUrls(text))) {
    await show(ctx, { text: t("extract-none") });
    return;
  }
  const langFrom = ctx.user.langFrom ?? "en";
  const langTo = ctx.user.langTo ?? ctx.user.uiLang;
  const deckId = options.deckId ?? null;
  const ref = await showTracked(ctx, { text: t("extract-searching") });
  const result = await deps.extract.extract({ user: ctx.user, text, now: deps.now() });

  if (result.kind === "unavailable") {
    await editTracked(ctx, ref, { text: t("extract-no-llm") });
    return;
  }
  if (result.kind === "limit") {
    await editTracked(ctx, ref, {
      text: t("extract-limit", { limit: FREE_LIMITS.textsPerDay }),
    });
    return;
  }
  if (result.kind === "failed") {
    deps.events.record(ctx.user.id, "word_generation_failed", {
      reason: result.reason,
      via: "extract",
    });
    await editTracked(ctx, ref, { text: t("extract-failed") });
    return;
  }

  // Every completed call is recorded, empty ones included: it cost a request
  // and it spends the daily text budget (SPEC §9.1).
  deps.events.record(ctx.user.id, "text_extracted", {
    words: result.kind === "extracted" ? result.words.length : 0,
    dropped: result.kind === "extracted" ? result.dropped : 0,
    model: deps.extract.llm.model,
    latencyMs: result.latencyMs,
    chars: result.chars,
    detectedLang: result.detectedLang,
  });

  if (result.kind === "native") {
    await editTracked(ctx, ref, {
      text: t("extract-native", {
        langTo: languageName(langTo, ctx.user.uiLang),
        lang: languageName(langFrom, ctx.user.uiLang),
      }),
    });
    return;
  }
  if (result.kind === "wrong_lang") {
    const known = getLanguage(result.detectedLang) !== null;
    await editTracked(ctx, ref, {
      text: known
        ? t("extract-wrong-lang-detected", {
            lang: languageName(langFrom, ctx.user.uiLang),
            detected: languageName(result.detectedLang, ctx.user.uiLang),
          })
        : t("extract-wrong-lang", { lang: languageName(langFrom, ctx.user.uiLang) }),
    });
    return;
  }

  if (result.words.length === 0) {
    const lines = [t("extract-none")];
    if (result.dropped > 0) lines.push(t("extract-dropped", { n: result.dropped }));
    await editTracked(ctx, ref, { text: lines.join("\n") });
    return;
  }

  const deck = await deps.add.resolveDeck(ctx.user, deckId, personalTitle(ctx));
  const rev = nextRev(ctx.user);
  const words = toPendingWords(result.words);
  await saveDraft(ctx, deps, rev, {
    deckId: deck.id,
    extract: {
      words,
      dropped: result.dropped,
      ...(result.truncated ? { truncated: true } : {}),
    },
  });
  await editTracked(
    ctx,
    ref,
    renderChecklist(t, {
      words,
      dropped: result.dropped,
      deckTitle: deck.title,
      ...(result.truncated ? { truncated: true } : {}),
      rev,
    }),
  );
}

/** Asks for a text; the answer goes straight into `runExtraction`. */
async function promptForText(ctx: BotContext, deps: BotDeps): Promise<void> {
  const t = ctx.t.bind(ctx);
  if (!deps.extract.llm) {
    await show(ctx, { text: t("extract-no-llm") });
    return;
  }
  const rev = nextRev(ctx.user);
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, EXTRACT_TEXT, {
      now: deps.now(),
      payload: { rev },
    }),
  );
  await show(ctx, askTextScreen(t, rev));
}

/** Text that answers the «Пришли текст» question. Returns true when consumed. */
export async function handleExtractInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending !== EXTRACT_TEXT) return false;
  const deckId = ctx.user.pendingPayload?.deckId ?? null;
  await clearDraft(ctx, deps);
  await runExtraction(ctx, deps, text, { deckId });
  return true;
}

/** Re-renders the checklist after a toggle, keeping the draft revision. */
async function redrawChecklist(
  ctx: BotContext,
  deps: BotDeps,
  rev: number,
  words: PendingExtractWord[],
): Promise<void> {
  const payload = ctx.user.pendingPayload;
  const extract = payload?.extract;
  if (!extract) return;
  const deck = await deps.add.resolveDeck(ctx.user, payload?.deckId ?? null, personalTitle(ctx));
  await saveDraft(ctx, deps, rev, {
    deckId: deck.id,
    extract: { ...extract, words },
  });
  await show(
    ctx,
    renderChecklist(ctx.t.bind(ctx), {
      words,
      dropped: extract.dropped,
      deckTitle: deck.title,
      ...(extract.truncated ? { truncated: true } : {}),
      rev,
    }),
  );
}

export function installExtract(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("extract", async (ctx) => {
    await promptForText(ctx, deps);
  });

  bot.callbackQuery("x:ask", async (ctx) => {
    await answer(ctx);
    await promptForText(ctx, deps);
  });

  bot.callbackQuery(/^x:cancel:/u, async (ctx) => {
    if ((await freshRev(ctx, ctx.callbackQuery.data)) === null) return;
    await answer(ctx, ctx.t("toast-cancelled"));
    await clearDraft(ctx, deps);
    await show(ctx, { text: ctx.t("add-cancelled") });
  });

  /** One checkbox. */
  bot.callbackQuery(/^x:t:/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const words = ctx.user.pendingPayload?.extract?.words;
    const index = argInt(parseCallback(ctx.callbackQuery.data)!, 1);
    if (!words || index === null || !words[index]) return;
    const updated = words.map((word, i) => (i === index ? { ...word, on: !word.on } : word));
    await redrawChecklist(ctx, deps, rev, updated);
  });

  /** «Выбрать все» / «Снять все». */
  const setAll = (on: boolean) => async (ctx: BotContext) => {
    const rev = await freshRev(ctx, ctx.callbackQuery?.data);
    if (rev === null) return;
    await answer(ctx);
    const words = ctx.user.pendingPayload?.extract?.words;
    if (!words) return;
    await redrawChecklist(
      ctx,
      deps,
      rev,
      words.map((word) => ({ ...word, on })),
    );
  };
  bot.callbackQuery(/^x:all:/u, setAll(true));
  bot.callbackQuery(/^x:none:/u, setAll(false));

  bot.callbackQuery(/^x:decks:/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const decks = await deps.add.listOwnDecks(ctx.user.id);
    const keyboard = new InlineKeyboard();
    for (const deck of decks) {
      keyboard.text(deck.title, cb(NS.extract, "deck", rev, deck.id)).row();
    }
    keyboard.text(ctx.t("btn-cancel"), cb(NS.extract, "cancel", rev));
    await show(ctx, { text: ctx.t("add-choose-deck"), keyboard });
  });

  bot.callbackQuery(/^x:deck:/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 1);
    const extract = ctx.user.pendingPayload?.extract;
    if (!extract || deckId === null) return;
    const deck = await deps.repos.decks.findById(deckId);
    await saveDraft(ctx, deps, rev, { deckId, extract });
    await show(
      ctx,
      renderChecklist(ctx.t.bind(ctx), {
        words: extract.words,
        dropped: extract.dropped,
        deckTitle: deck?.title ?? "",
        ...(extract.truncated ? { truncated: true } : {}),
        rev,
      }),
    );
  });

  /** «✅ Добавить выбранные»: generate a card per ticked word and save them. */
  bot.callbackQuery(/^x:add:/u, async (ctx) => {
    const rev = await freshRev(ctx, ctx.callbackQuery.data);
    if (rev === null) return;
    const t = ctx.t.bind(ctx);
    const payload = ctx.user.pendingPayload;
    const extract = payload?.extract;
    if (!extract) {
      await answer(ctx);
      await show(ctx, { text: t("add-expired") });
      return;
    }
    const chosen = extract.words.filter((word) => word.on);
    if (chosen.length === 0) {
      await answer(ctx, t("extract-nothing-selected"));
      return;
    }
    await answer(ctx);
    await show(ctx, { text: t("extract-adding") });
    const result = await deps.extract.addWords({
      user: ctx.user,
      words: chosen.map((word) => ({ front: word.front, back: word.back })),
      deckId: payload?.deckId ?? null,
      personalTitle: personalTitle(ctx),
      now: deps.now(),
    });
    for (const generation of result.generations) {
      deps.events.record(ctx.user.id, "word_generated", {
        cached: generation.cached,
        latencyMs: generation.latencyMs,
        model: deps.extract.llm?.model ?? null,
        langFrom: ctx.user.langFrom ?? "en",
        langTo: ctx.user.langTo ?? ctx.user.uiLang,
        via: "extract",
      });
    }
    deps.events.record(ctx.user.id, "text_words_added", { n: result.added.length });
    await saveDraft(ctx, deps, rev, {
      deckId: result.deck.id,
      learn: result.added.map((word) => word.note.id),
    });
    await show(
      ctx,
      renderExtractSummary(t, {
        deckTitle: result.deck.title,
        added: result.added,
        skipped: result.skipped,
        budgetSkipped: result.budgetSkipped,
        ...(result.noteLimit ? { noteLimit: result.noteLimit.limit } : {}),
        rev,
      }),
    );
  });

  /** «▶️ Учить новые»: a session over exactly the words we just added. */
  bot.callbackQuery(/^x:learn:/u, async (ctx) => {
    if ((await freshRev(ctx, ctx.callbackQuery.data)) === null) return;
    await answer(ctx);
    const noteIds = ctx.user.pendingPayload?.learn ?? [];
    const cardIds: number[] = [];
    for (const noteId of noteIds) {
      cardIds.push(
        await deps.repos.cards.createCard({
          userId: ctx.user.id,
          noteId,
          mode: "recognition",
          due: deps.now(),
        }),
      );
    }
    const view =
      cardIds.length > 0
        ? await deps.sessions.startWith({
            user: ctx.user,
            chatId: ctx.chat?.id ?? ctx.user.tgId,
            deckId: null,
            cardIds,
            now: deps.now(),
          })
        : null;
    if (view) await renderSession(ctx, deps, view.session, renderCard(ctx.t.bind(ctx), view));
    else await openSession(ctx, deps);
  });
}

/** Exported for the router: which pending tokens this feature owns. */
export function ownsPendingInput(pending: string): boolean {
  return pending === EXTRACT_TEXT;
}

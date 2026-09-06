import { type Bot, InlineKeyboard } from "grammy";
import type { CatalogDeck, DeckWithCounts } from "../db/repos/decks.js";
import type { CardMode, Deck } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import { languageName } from "../i18n/languages.js";
import { argInt, argStr, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { esc } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { answer, type Screen, send, show } from "./ui.js";

export const DECKS_PER_PAGE = 8;
/** New-cards-per-day presets on the deck screen (SPEC §5.1, §8). */
export const NEW_PER_DAY_OPTIONS = [5, 10, 20, 30] as const;
export const DECK_TITLE_INPUT = "deck_title";
export const MAX_DECK_TITLE = 60;

function modesLabel(t: Translate, modes: CardMode[]): string {
  const parts = modes.map((mode) =>
    mode === "recognition" ? t("mode-recognition") : t("mode-recall"),
  );
  return parts.join(" · ");
}

/** "📖 Мои деки" with per-deck counters (SPEC §5.1). */
export function renderDeckList(t: Translate, decks: DeckWithCounts[], page: number): Screen {
  const pages = Math.max(1, Math.ceil(decks.length / DECKS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = decks.slice(current * DECKS_PER_PAGE, (current + 1) * DECKS_PER_PAGE);

  const lines = [t("decks-title")];
  if (decks.length === 0) lines.push(t("decks-empty"));
  for (const row of slice) {
    lines.push(
      `${esc(row.deck.title)} — ${t("decks-counts", {
        fresh: row.fresh,
        due: row.due,
        total: row.total,
      })}`,
    );
  }

  const keyboard = new InlineKeyboard();
  for (const row of slice) {
    keyboard.text(row.deck.title, cb(NS.decks, "v", row.deck.id)).row();
  }
  if (pages > 1) {
    if (current > 0) keyboard.text("‹", cb(NS.decks, "p", current - 1));
    keyboard.text(`${current + 1}/${pages}`, cb(NS.noop));
    if (current < pages - 1) keyboard.text("›", cb(NS.decks, "p", current + 1));
    keyboard.row();
  }
  keyboard
    .text(t("btn-new-deck"), cb(NS.decks, "new"))
    .text(t("btn-catalog"), cb(NS.decks, "cat"))
    .row()
    .text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

export function renderDeckCard(t: Translate, row: DeckWithCounts, ownerId: number): Screen {
  const own = row.deck.ownerId === ownerId;
  const lines = [esc(row.deck.title)];
  if (row.deck.description) lines.push(esc(row.deck.description));
  lines.push(
    t("deck-stats", {
      fresh: row.fresh,
      due: row.due,
      learned: row.learned,
      total: row.total,
    }),
  );
  lines.push(
    t("deck-settings", {
      perDay: row.newPerDay ?? t("deck-per-day-default"),
      modes: modesLabel(t, row.modes),
    }),
  );
  // Words the user switched off ("Знаю", "Приостановить") — silent unless there
  // are any, and then one tap brings them all back (SPEC §5.1).
  if (row.disabled > 0) lines.push(t("deck-disabled", { n: row.disabled }));

  const keyboard = new InlineKeyboard()
    .text(t("btn-learn-deck"), cb(NS.learn, "d", row.deck.id))
    .row()
    .text(t("btn-new-per-day"), cb(NS.decks, "npd", row.deck.id))
    .text(t("btn-modes"), cb(NS.decks, "modes", row.deck.id))
    .row();
  if (row.disabled > 0) {
    keyboard.text(t("btn-restore-disabled"), cb(NS.decks, "unsusp", row.deck.id)).row();
  }
  keyboard.text(t("btn-share"), cb(NS.decks, "share", row.deck.id));
  keyboard
    .text(
      own ? t("btn-delete-deck") : t("btn-unsubscribe"),
      cb(NS.decks, own ? "del" : "unsub", row.deck.id),
    )
    .row()
    .text(t("btn-back"), cb(NS.decks));
  return { text: lines.join("\n"), keyboard };
}

export function renderCatalog(
  t: Translate,
  langFrom: string,
  uiLang: string,
  rows: CatalogDeck[],
): Screen {
  const lines = [t("catalog-title", { lang: languageName(langFrom, uiLang) })];
  if (rows.length === 0) lines.push(t("catalog-empty"));
  for (const row of rows) {
    lines.push(
      t("catalog-row", {
        title: esc(row.deck.title),
        level: row.deck.level ?? "",
        total: row.total,
        mark: row.subscribed ? "✓" : "",
      }),
    );
  }
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    if (row.subscribed) continue;
    keyboard.text(row.deck.title, cb(NS.decks, "add", row.deck.id)).row();
  }
  keyboard.text(t("btn-back"), cb(NS.decks));
  return { text: lines.join("\n"), keyboard };
}

function shareLink(botUsername: string, deck: Deck): string {
  return `https://t.me/${botUsername}?start=deck_${deck.slug ?? deck.publicId ?? deck.id}`;
}

async function deckRow(
  deps: BotDeps,
  ctx: BotContext,
  deckId: number,
): Promise<DeckWithCounts | null> {
  const rows = await deps.repos.decks.listSubscribedWithCounts({
    userId: ctx.user.id,
    now: deps.now(),
  });
  return rows.find((row) => row.deck.id === deckId) ?? null;
}

async function showList(ctx: BotContext, deps: BotDeps, page = 0): Promise<void> {
  const rows = await deps.repos.decks.listSubscribedWithCounts({
    userId: ctx.user.id,
    now: deps.now(),
  });
  await show(ctx, renderDeckList(ctx.t.bind(ctx), rows, page));
}

async function showDeck(ctx: BotContext, deps: BotDeps, deckId: number): Promise<void> {
  const row = await deckRow(deps, ctx, deckId);
  if (!row) {
    await showList(ctx, deps);
    return;
  }
  await show(ctx, renderDeckCard(ctx.t.bind(ctx), row, ctx.user.id));
}

/** The "новая дека" title arrived as free text. */
export async function handleDeckInput(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  text: string,
): Promise<boolean> {
  if (pending !== DECK_TITLE_INPUT) return false;
  const title = text.trim().replace(/\s+/gu, " ").slice(0, MAX_DECK_TITLE);
  if (title.length === 0) {
    await ctx.reply(ctx.t("deck-title-bad"));
    return true;
  }
  const check = await deps.limits.canCreateDeck(ctx.user, deps.now());
  ctx.setUser(await deps.repos.users.setPendingInput(ctx.user.id, null, { now: deps.now() }));
  if (!check.allowed) {
    await ctx.reply(ctx.t("deck-limit", { limit: check.limit }));
    return true;
  }
  const langFrom = ctx.user.langFrom ?? "en";
  const deck = await deps.repos.decks.createUserDeck({
    ownerId: ctx.user.id,
    title,
    langFrom,
    langTo: ctx.user.langTo ?? ctx.user.uiLang,
  });
  await deps.repos.decks.subscribe(ctx.user.id, deck.id);
  deps.events.record(ctx.user.id, "deck_created", { deckId: deck.id });
  await send(ctx, { text: ctx.t("deck-created", { title: esc(deck.title) }) });
  await showDeck(ctx, deps, deck.id);
  return true;
}

export function installDecks(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("decks", async (ctx) => {
    await showList(ctx, deps);
  });

  bot.callbackQuery(cb(NS.noop), (ctx) => answer(ctx));

  bot.callbackQuery("d", async (ctx) => {
    await answer(ctx);
    await showList(ctx, deps);
  });

  bot.callbackQuery(/^d:p:/u, async (ctx) => {
    await answer(ctx);
    await showList(ctx, deps, argInt(parseCallback(ctx.callbackQuery.data)!, 0) ?? 0);
  });

  bot.callbackQuery(/^d:v:/u, async (ctx) => {
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId !== null) await showDeck(ctx, deps, deckId);
  });

  bot.callbackQuery("d:new", async (ctx) => {
    await answer(ctx);
    const check = await deps.limits.canCreateDeck(ctx.user, deps.now());
    if (!check.allowed) {
      await show(ctx, {
        text: ctx.t("deck-limit", { limit: check.limit }),
        keyboard: new InlineKeyboard().text(ctx.t("btn-back"), cb(NS.decks)),
      });
      return;
    }
    ctx.setUser(
      await deps.repos.users.setPendingInput(ctx.user.id, DECK_TITLE_INPUT, { now: deps.now() }),
    );
    await show(ctx, {
      text: ctx.t("deck-ask-title"),
      keyboard: new InlineKeyboard().text(ctx.t("btn-back"), cb(NS.decks)),
    });
  });

  bot.callbackQuery("d:cat", async (ctx) => {
    await answer(ctx);
    const langFrom = ctx.user.langFrom ?? "en";
    const rows = await deps.repos.decks.listCatalog({ userId: ctx.user.id, langFrom });
    await show(ctx, renderCatalog(ctx.t.bind(ctx), langFrom, ctx.user.uiLang, rows));
  });

  bot.callbackQuery(/^d:add:/u, async (ctx) => {
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    const deck = await deps.repos.decks.findById(deckId);
    if (!deck) return;
    await deps.repos.decks.subscribe(ctx.user.id, deckId);
    deps.events.record(ctx.user.id, "deck_subscribed", { deckId, via: "catalog" });
    await show(ctx, {
      text: ctx.t("deck-subscribed", { title: esc(deck.title) }),
      keyboard: new InlineKeyboard()
        .text(ctx.t("btn-learn-deck"), cb(NS.learn, "d", deckId))
        .text(ctx.t("btn-back"), cb(NS.decks)),
    });
  });

  bot.callbackQuery(/^d:unsub:/u, async (ctx) => {
    await answer(ctx, ctx.t("toast-unsubscribed"));
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    await deps.repos.decks.unsubscribe(ctx.user.id, deckId);
    deps.events.record(ctx.user.id, "deck_unsubscribed", { deckId });
    await showList(ctx, deps);
  });

  bot.callbackQuery(/^d:unsusp:/u, async (ctx) => {
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return answer(ctx);
    const restored = await deps.repos.cards.restoreSuspended({
      userId: ctx.user.id,
      deckId,
    });
    await answer(ctx, ctx.t("toast-restored", { n: restored }));
    deps.events.record(ctx.user.id, "deck_restored", { deckId, cards: restored });
    await showDeck(ctx, deps, deckId);
  });

  bot.callbackQuery(/^d:del:/u, async (ctx) => {
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    const deck = await deps.repos.decks.findById(deckId);
    if (!deck || deck.ownerId !== ctx.user.id) return;
    await show(ctx, {
      text: ctx.t("deck-delete-confirm", { title: esc(deck.title) }),
      keyboard: new InlineKeyboard()
        .text(ctx.t("btn-delete-confirm"), cb(NS.decks, "delok", deckId))
        .text(ctx.t("btn-cancel"), cb(NS.decks, "v", deckId)),
    });
  });

  bot.callbackQuery(/^d:delok:/u, async (ctx) => {
    await answer(ctx, ctx.t("toast-deleted"));
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    const deck = await deps.repos.decks.findById(deckId);
    if (!deck || deck.ownerId !== ctx.user.id) return;
    await deps.repos.decks.deleteDeck(deckId);
    deps.events.record(ctx.user.id, "deck_deleted", { deckId });
    await showList(ctx, deps);
  });

  bot.callbackQuery(/^d:npd:/u, async (ctx) => {
    await answer(ctx);
    const parsed = parseCallback(ctx.callbackQuery.data)!;
    const deckId = argInt(parsed, 0);
    if (deckId === null) return;
    const value = argStr(parsed, 1);
    if (value === null) {
      const keyboard = new InlineKeyboard();
      for (const option of NEW_PER_DAY_OPTIONS) {
        keyboard.text(String(option), cb(NS.decks, "npd", deckId, option));
      }
      keyboard
        .row()
        .text(ctx.t("btn-per-day-default"), cb(NS.decks, "npd", deckId, "d"))
        .row()
        .text(ctx.t("btn-back"), cb(NS.decks, "v", deckId));
      await show(ctx, { text: ctx.t("deck-ask-per-day"), keyboard });
      return;
    }
    await deps.repos.decks.updateSubscription(ctx.user.id, deckId, {
      newPerDay: value === "d" ? null : Number(value),
    });
    await showDeck(ctx, deps, deckId);
  });

  bot.callbackQuery(/^d:modes:/u, async (ctx) => {
    await answer(ctx);
    const parsed = parseCallback(ctx.callbackQuery.data)!;
    const deckId = argInt(parsed, 0);
    if (deckId === null) return;
    const value = argStr(parsed, 1);
    if (value === null) {
      const keyboard = new InlineKeyboard()
        .text(ctx.t("mode-recognition"), cb(NS.decks, "modes", deckId, "r"))
        .row()
        .text(ctx.t("mode-both"), cb(NS.decks, "modes", deckId, "rr"))
        .row()
        .text(ctx.t("btn-back"), cb(NS.decks, "v", deckId));
      await show(ctx, { text: ctx.t("deck-ask-modes"), keyboard });
      return;
    }
    const modes: CardMode[] = value === "rr" ? ["recognition", "recall"] : ["recognition"];
    await deps.repos.decks.updateSubscription(ctx.user.id, deckId, { modes });
    await showDeck(ctx, deps, deckId);
  });

  bot.callbackQuery(/^d:share:/u, async (ctx) => {
    await answer(ctx);
    const deckId = argInt(parseCallback(ctx.callbackQuery.data)!, 0);
    if (deckId === null) return;
    const deck = await deps.repos.decks.findById(deckId);
    if (!deck) return;
    if (deck.kind !== "builtin" && !deck.publicId) {
      await deps.repos.decks.ensurePublicId(deckId);
    }
    const fresh = (await deps.repos.decks.findById(deckId)) ?? deck;
    await show(ctx, {
      text: ctx.t("deck-share", {
        title: esc(fresh.title),
        link: shareLink(deps.botUsername(), fresh),
      }),
      keyboard: new InlineKeyboard().text(ctx.t("btn-back"), cb(NS.decks, "v", deckId)),
    });
  });
}

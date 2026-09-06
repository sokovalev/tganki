import { type Bot, InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import type { ReviewRating } from "../core/scheduler.js";
import { learningDayKey } from "../core/streak.js";
import type { Session } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import {
  CHOICE_RIGHT,
  CHOICE_WRONG,
  type ChoiceOption,
  type EmptyQueue,
  EXTRA_NEW_BATCH,
  type SessionSummary,
  type SessionView,
} from "../services/sessionService.js";
import { argInt, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import {
  bold,
  esc,
  formatInterval,
  italic,
  localTime,
  ratingLabel,
  SEPARATOR,
  truncate,
} from "./format.js";
import { cb, NS } from "./keyboards.js";
import {
  answer,
  EDIT_WINDOW_MS,
  htmlOptions,
  isEditImpossible,
  isNotModified,
  type Screen,
  show,
} from "./ui.js";

const RATINGS: readonly ReviewRating[] = [1, 2, 3, 4];
/** Longest option label on the «выбор из четырёх» screen (SPEC §3.2). */
export const CHOICE_LABEL_MAX = 40;

function transcription(view: SessionView, side: "question" | "answer"): string | null {
  if (!view.card.transcription) return null;
  const mode = view.transcriptionMode;
  if (mode === "never" || (mode === "answer" && side === "question")) return null;
  return italic(`/${esc(view.card.transcription)}/`);
}

/** Question side: the word for `recognition`, the translation for `recall`. */
function questionLines(view: SessionView): string[] {
  if (view.card.mode === "recall") return [bold(esc(view.card.back))];
  return [bold(esc(view.card.front)), transcription(view, "question")].filter(
    (line): line is string => line !== null,
  );
}

function answerLines(view: SessionView): string[] {
  const { card } = view;
  const lines =
    card.mode === "recall"
      ? [bold(esc(card.front)), transcription(view, "answer")]
      : [transcription(view, "answer"), esc(card.back)];
  if (card.example) lines.push(italic(esc(card.example)));
  if (card.exampleTr && card.mode !== "recall") lines.push(esc(card.exampleTr));
  return lines.filter((line): line is string => line !== null);
}

function header(t: Translate, view: SessionView): string[] {
  const lines = [`${bold(esc(view.card.deckTitle))}   ${view.index} / ${view.total}`];
  // The presentation screen says it in words — this word is brand new.
  if (view.stage === "intro") lines.push(t("session-intro-new"));
  else if (view.isNew) lines.push(t("session-new"));
  if (view.snowball) lines.push(t("session-snowball"));
  return lines;
}

/**
 * «Знакомство» (SPEC §3.2, §3.3): the whole card at once, nothing to answer.
 * The transcription belongs to the answer side and this screen *is* the answer
 * side, so the "only in the answer" setting shows it here; "never" still hides
 * it.
 */
function renderIntro(t: Translate, view: SessionView): Screen {
  const pos = view.position;
  const { card } = view;
  const text = [
    ...header(t, view),
    SEPARATOR,
    bold(esc(card.front)),
    transcription(view, "answer"),
    SEPARATOR,
    esc(card.back),
    card.example ? italic(esc(card.example)) : null,
    card.exampleTr ? esc(card.exampleTr) : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // A first meeting is a yes/no question, not a "next": «Знаю» switches the
  // word off everywhere, «Не знаю» starts learning it (SPEC §3.2).
  const keyboard = new InlineKeyboard()
    .text(t("btn-known"), cb(NS.session, "know", pos))
    .text(t("btn-intro-next"), cb(NS.session, "intro", pos))
    .row()
    .text(t("btn-card-menu"), cb(NS.card, "open", pos))
    .text(t("btn-finish"), cb(NS.session, "fin"));
  return { text, keyboard };
}

/** What the ✏️ menu may offer beyond the fixed items. */
export interface CardMenuOptions {
  /** «✨ Дополнить» — only for own notes, and only when generation is on. */
  canEnrich?: boolean;
}

/** Question or answer screen — one message, edited in place (SPEC §3.3). */
export function renderCard(t: Translate, view: SessionView, options: CardMenuOptions = {}): Screen {
  const pos = view.position;
  if (view.stage === "actions") return renderActions(t, view, options);
  if (view.stage === "intro") return renderIntro(t, view);

  if (view.stage === "question") {
    if (view.choices) return renderChoice(t, view, view.choices);
    const text = [...header(t, view), SEPARATOR, ...questionLines(view)].join("\n");
    const keyboard = new InlineKeyboard()
      .text(t("btn-show-answer"), cb(NS.session, "show", pos))
      .row();
    // "Знаю" only makes sense before the word was ever studied; a row of its
    // own, four buttons in one row get truncated on phones (SPEC §3.7).
    if (view.isNew) keyboard.text(t("btn-known"), cb(NS.session, "know", pos)).row();
    keyboard
      .text(t("btn-card-menu"), cb(NS.card, "open", pos))
      .text(t("btn-skip"), cb(NS.session, "skip", pos))
      .text(t("btn-finish"), cb(NS.session, "fin"));
    return { text, keyboard };
  }

  // Interval previews live in the text, not in the button labels: four
  // buttons in one row get truncated on phones ("Again · …").
  const previews = view.previews
    ? RATINGS.map(
        (rating) => `${ratingLabel(t, rating)} ${formatInterval(t, view.previews![rating])}`,
      )
    : [];
  const text = [
    // A missed «выбор из четырёх» names the right answer above everything else
    // (SPEC §3.2) — that line is the whole point of stopping here.
    ...(view.choiceResult === "hit" ? [t("choice-right")] : []),
    ...(view.choiceResult === "miss" ? [t("choice-wrong", { answer: esc(view.card.back) })] : []),
    ...header(t, view),
    SEPARATOR,
    ...questionLines(view),
    SEPARATOR,
    ...answerLines(view),
    ...(previews.length > 0 ? ["", italic(esc(previews.join(" · ")))] : []),
  ].join("\n");

  const keyboard = new InlineKeyboard();
  if (view.choiceResult !== null) {
    // The rating was applied by the tap, so there is nothing left to grade:
    // one button moves on, «Отменить» takes the automatic «Снова» back. No
    // ✏️ here — the queue has already moved on, so the card menu would act on
    // the next card, not on the word that was just missed.
    keyboard.text(t("btn-choice-next"), cb(NS.session, "next", pos)).row();
    if (view.canUndo) keyboard.text(t("btn-undo"), cb(NS.session, "undo"));
    keyboard.text(t("btn-finish"), cb(NS.session, "fin"));
    return { text, keyboard };
  }
  for (const rating of RATINGS) {
    keyboard.text(ratingLabel(t, rating), cb(NS.rate, String(pos), rating));
  }
  keyboard.row();
  // The word may turn out to be familiar only once the translation is seen,
  // so a new card keeps its "Знаю" on the answer side too.
  if (view.isNew) keyboard.text(t("btn-known"), cb(NS.session, "know", pos)).row();
  if (view.canUndo) keyboard.text(t("btn-undo"), cb(NS.session, "undo"));
  keyboard.text(t("btn-card-menu"), cb(NS.card, "open", pos));
  keyboard.text(t("btn-finish"), cb(NS.session, "fin"));
  return { text, keyboard };
}

/**
 * «Выбор из четырёх» (SPEC §3.2, §3.3): the word plus four translations, one
 * per row so a long option stays readable. The buttons carry the queue
 * position, exactly like the rating buttons, so a double tap is ignored; the
 * option index is checked against the note ids stored in the queue item.
 */
function renderChoice(t: Translate, view: SessionView, choices: ChoiceOption[]): Screen {
  const pos = view.position;
  const text = [
    ...header(t, view),
    SEPARATOR,
    ...questionLines(view),
    SEPARATOR,
    t("choice-question"),
  ].join("\n");

  const keyboard = new InlineKeyboard();
  choices.forEach((option, i) => {
    keyboard
      .text(`${i + 1} · ${truncate(option.back, CHOICE_LABEL_MAX)}`, cb(NS.choice, String(pos), i))
      .row();
  });
  // The escape hatch back to the plain reveal flow.
  keyboard.text(t("btn-show-answer"), cb(NS.session, "show", pos)).row();
  if (view.isNew) keyboard.text(t("btn-known"), cb(NS.session, "know", pos)).row();
  keyboard
    .text(t("btn-card-menu"), cb(NS.card, "open", pos))
    .text(t("btn-skip"), cb(NS.session, "skip", pos))
    .text(t("btn-finish"), cb(NS.session, "fin"));
  return { text, keyboard };
}

/** True when the LLM could still add something to this note (SPEC §4.1a). */
export function canEnrichCard(view: SessionView): boolean {
  return view.card.deckOwnerId !== null && (!view.card.transcription || !view.card.example);
}

/** ✏️ menu over the current card (SPEC §3.5). */
export function renderActions(
  t: Translate,
  view: SessionView,
  options: CardMenuOptions = {},
): Screen {
  const pos = view.position;
  const own = view.card.deckOwnerId !== null;
  const keyboard = new InlineKeyboard()
    .text(t("btn-known-menu"), cb(NS.card, "know", pos))
    .row()
    .text(t("btn-suspend"), cb(NS.card, "susp", pos))
    .row()
    .text(t("btn-bury"), cb(NS.card, "bury", pos))
    .row();
  if (options.canEnrich && canEnrichCard(view)) {
    keyboard.text(t("btn-enrich"), cb(NS.card, "enr", pos)).row();
  }
  if (!own) keyboard.text(t("btn-report"), cb(NS.card, "rep", pos)).row();
  if (own) keyboard.text(t("btn-delete-note"), cb(NS.card, "del", pos)).row();
  keyboard.text(t("btn-back"), cb(NS.session, "back", pos));
  return {
    text: [
      bold(esc(view.card.front)),
      SEPARATOR,
      t("card-actions-title", { word: view.card.front }),
    ].join("\n"),
    keyboard,
  };
}

/** "завтра в 08:00" / "сегодня в 19:00" / "12 марта в 08:00". */
export function formatWhen(t: Translate, at: Date, tz: string, now: Date): string {
  const time = localTime(at, tz);
  const today = learningDayKey(now, tz);
  const day = learningDayKey(at, tz);
  if (day === today) return t("when-today", { time });
  const tomorrow = DateTime.fromISO(today, { zone: "UTC" }).plus({ days: 1 }).toISODate();
  if (day === tomorrow) return t("when-tomorrow", { time });
  return t("when-date", { date: day, time });
}

export function renderEmpty(
  t: Translate,
  view: EmptyQueue,
  options: { tz: string; now: Date },
): Screen {
  const lines = [t("empty-title")];
  if (view.snowball) lines.push(t("session-snowball"));
  if (view.nextAt) {
    lines.push(
      t("empty-next", {
        when: formatWhen(t, view.nextAt, options.tz, options.now),
        n: view.nextCount,
      }),
    );
  } else {
    lines.push(t("empty-none"));
  }
  const keyboard = new InlineKeyboard()
    .text(t("btn-extra-new", { n: EXTRA_NEW_BATCH }), cb(NS.session, "more"))
    .row()
    .text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

export function renderSummary(t: Translate, view: SessionSummary): Screen {
  const lines = [
    t("summary-title", { cards: view.stats.reviewed, minutes: view.minutes }),
    "",
    t("summary-ratings", {
      again: view.stats.again,
      hard: view.stats.hard,
      good: view.stats.good,
      easy: view.stats.easy,
    }),
    t("summary-accuracy", { accuracy: view.accuracy, new: view.stats.newLearned }),
    t("summary-streak", { n: view.streak }),
  ];
  const keyboard = new InlineKeyboard();
  if (view.remainingDue > 0) {
    lines.push("", t("summary-remaining", { n: view.remainingDue }));
    keyboard.text(t("btn-continue", { n: view.remainingDue }), cb(NS.session, "cont"));
  }
  keyboard.text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

export function renderLeech(t: Translate, leech: { cardId: number; front: string }): Screen {
  return {
    text: t("leech-notice", { word: leech.front }),
    keyboard: new InlineKeyboard()
      .text(t("btn-suspend"), cb(NS.leech, "susp", leech.cardId))
      .text(t("btn-keep"), cb(NS.leech, "keep", leech.cardId)),
  };
}

/**
 * Writes a screen into the session's own message: edits it when possible and
 * falls back to a new message when it was deleted or is older than 48 hours.
 */
export async function renderSession(
  ctx: BotContext,
  deps: BotDeps,
  session: Session,
  screen: Screen,
): Promise<void> {
  const options = {
    ...htmlOptions,
    ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
  };
  const sentAt = session.messageSentAt ?? session.startedAt;
  const fresh = deps.now().getTime() - sentAt.getTime() < EDIT_WINDOW_MS;
  if (session.messageId !== null && fresh) {
    try {
      await ctx.api.editMessageText(session.chatId, session.messageId, screen.text, options);
      return;
    } catch (error) {
      if (isNotModified(error)) return;
      if (!isEditImpossible(error)) throw error;
      deps.logger.debug({ sessionId: session.id }, "session message gone, sending a new one");
    }
  }
  const message = await ctx.api.sendMessage(session.chatId, screen.text, options);
  await deps.repos.sessions.save(session.id, {
    messageId: message.message_id,
    messageSentAt: deps.now(),
  });
  session.messageId = message.message_id;
  session.messageSentAt = deps.now();
}

/** Starts (or resumes) a session and renders it. Shared by /learn, menu and decks. */
export async function openSession(
  ctx: BotContext,
  deps: BotDeps,
  options: { deckId?: number | null; newLimit?: number; extraNew?: number } = {},
): Promise<void> {
  const now = deps.now();
  const user = ctx.user;
  const deckId = options.deckId ?? null;

  const active = await deps.sessions.current(user, now);
  if (active && options.extraNew === undefined) {
    const view = await deps.sessions.render(active, user, now, "question");
    if (view) {
      await renderSession(ctx, deps, active, renderCard(ctx.t.bind(ctx), view));
      return;
    }
    await deps.repos.sessions.finish(active.id, "finished");
  }

  const chatId = ctx.chat?.id ?? user.tgId;
  const result = await deps.sessions.start({
    user,
    deckId,
    chatId,
    now,
    ...(options.newLimit !== undefined ? { newLimit: options.newLimit } : {}),
    ...(options.extraNew !== undefined ? { extraNew: options.extraNew } : {}),
  });

  const t = ctx.t.bind(ctx);
  if (result.kind === "empty") {
    await show(ctx, renderEmpty(t, result, { tz: user.tz, now }));
    return;
  }
  deps.events.record(user.id, "session_start", {
    deckId,
    size: result.total,
  });
  await renderSession(ctx, deps, result.session, renderCard(t, result));
}

async function finishAndRender(
  ctx: BotContext,
  deps: BotDeps,
  summary: SessionSummary,
): Promise<void> {
  const t = ctx.t.bind(ctx);
  deps.events.record(summary.session.userId, "session_end", {
    reviewed: summary.stats.reviewed,
    accuracy: summary.accuracy,
  });
  await renderSession(ctx, deps, summary.session, renderSummary(t, summary));
  if (summary.leech) {
    const notice = renderLeech(t, summary.leech);
    await ctx.api.sendMessage(summary.session.chatId, notice.text, {
      ...htmlOptions,
      reply_markup: notice.keyboard,
    });
  }
}

export function installSession(bot: Bot<BotContext>, deps: BotDeps): void {
  const active = (ctx: BotContext) => deps.sessions.current(ctx.user, deps.now());

  bot.command("learn", async (ctx) => {
    await openSession(ctx, deps);
  });

  bot.callbackQuery(/^l(:d:\d+)?$/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    await answer(ctx);
    const deckId = parsed?.action === "d" ? argInt(parsed, 0) : null;
    await openSession(ctx, deps, { deckId });
  });

  bot.callbackQuery(/^s:show:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = argInt(parsed, 0);
    if (position !== session.position) return answer(ctx, ctx.t("toast-already-rated"));
    await answer(ctx);
    const view = await deps.sessions.render(session, ctx.user, deps.now(), "answer");
    if (view) await renderSession(ctx, deps, session, renderCard(ctx.t.bind(ctx), view));
  });

  /** «▶️ Дальше» on the «знакомство» screen (SPEC §3.2): `s:intro:<pos>`. */
  bot.callbackQuery(/^s:intro:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = argInt(parsed, 0);
    if (position === null) return answer(ctx);
    const result = await deps.sessions.introduce({
      user: ctx.user,
      session,
      position,
      now: deps.now(),
    });
    if ("kind" in result) return answer(ctx, ctx.t("toast-already-rated"));
    // Not a rating: the event is the only trace an introduction leaves.
    if (result.cardId !== null) {
      deps.events.record(ctx.user.id, "card_introduced", { cardId: result.cardId });
    }
    await answer(ctx);
    if (result.view.kind === "summary") {
      await finishAndRender(ctx, deps, result.view);
      return;
    }
    await renderSession(ctx, deps, result.view.session, renderCard(ctx.t.bind(ctx), result.view));
  });

  bot.callbackQuery(/^s:back:/u, async (ctx) => {
    const session = await active(ctx);
    if (!session) return answer(ctx, ctx.t("toast-session-gone"));
    await answer(ctx);
    const view = await deps.sessions.render(session, ctx.user, deps.now(), "question");
    if (view) await renderSession(ctx, deps, session, renderCard(ctx.t.bind(ctx), view));
  });

  bot.callbackQuery(/^r:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = Number(parsed.action);
    const rating = argInt(parsed, 0);
    if (!Number.isSafeInteger(position) || rating === null || rating < 1 || rating > 4) {
      return answer(ctx);
    }
    const result = await deps.sessions.rate({
      user: ctx.user,
      session,
      position,
      rating: rating as ReviewRating,
      now: deps.now(),
    });
    if (result.kind === "stale") return answer(ctx, ctx.t("toast-already-rated"));
    if (result.kind === "gone") return answer(ctx, ctx.t("toast-session-gone"));

    deps.events.record(ctx.user.id, "review", { rating });
    await answer(ctx, result.freezeUsed ? ctx.t("toast-freeze") : undefined);
    if (result.kind === "summary") {
      await finishAndRender(ctx, deps, result);
      return;
    }
    await renderSession(ctx, deps, result.session, renderCard(ctx.t.bind(ctx), result));
  });

  /** «Выбор из четырёх» (SPEC §3.2): `ch:<pos>:<i>`, i = 0..3. */
  bot.callbackQuery(/^ch:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = Number(parsed.action);
    const option = argInt(parsed, 0);
    if (!Number.isSafeInteger(position) || option === null) return answer(ctx);

    const result = await deps.sessions.choose({
      user: ctx.user,
      session,
      position,
      option,
      now: deps.now(),
    });
    if (result.kind === "stale") return answer(ctx, ctx.t("toast-already-rated"));
    if (result.kind === "gone") return answer(ctx, ctx.t("toast-session-gone"));

    const rating = result.correct ? CHOICE_RIGHT : CHOICE_WRONG;
    deps.events.record(ctx.user.id, "review", { rating, via: "choice" });
    await answer(ctx, result.freezeUsed ? ctx.t("toast-freeze") : undefined);
    if (result.kind === "summary") {
      await finishAndRender(ctx, deps, result);
      return;
    }
    await renderSession(ctx, deps, result.session, renderCard(ctx.t.bind(ctx), result));
  });

  /** «Дальше ▶️» on the screen a missed choice stops at. */
  bot.callbackQuery(/^s:next:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = argInt(parsed, 0);
    if (position === null) return answer(ctx);
    const result = await deps.sessions.next({
      user: ctx.user,
      session,
      position,
      now: deps.now(),
    });
    if ("kind" in result && result.kind === "stale") {
      return answer(ctx, ctx.t("toast-already-rated"));
    }
    await answer(ctx);
    if (result.kind === "summary") {
      await finishAndRender(ctx, deps, result);
      return;
    }
    await renderSession(ctx, deps, result.session, renderCard(ctx.t.bind(ctx), result));
  });

  /** «Знаю»: shared by the question screen and the ✏️ menu (SPEC §3.7). */
  const markKnown = async (ctx: BotContext, position: number): Promise<void> => {
    const session = await active(ctx);
    if (!session) {
      await answer(ctx, ctx.t("toast-session-gone"));
      return;
    }
    const result = await deps.sessions.markKnown({
      user: ctx.user,
      session,
      position,
      now: deps.now(),
    });
    if ("kind" in result) {
      await answer(ctx, ctx.t("toast-already-rated"));
      return;
    }
    deps.events.record(ctx.user.id, "word_known", { word: result.word });
    await answer(ctx, ctx.t("toast-known", { word: result.word }));
    if (result.view.kind === "summary") {
      await finishAndRender(ctx, deps, result.view);
      return;
    }
    await renderSession(ctx, deps, result.view.session, renderCard(ctx.t.bind(ctx), result.view));
  };

  bot.callbackQuery(/^s:know:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const position = parsed ? argInt(parsed, 0) : null;
    if (position === null) return answer(ctx);
    await markKnown(ctx, position);
  });

  bot.callbackQuery(/^s:skip:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = argInt(parsed, 0);
    if (position === null) return answer(ctx);
    const result = await deps.sessions.skip({
      user: ctx.user,
      session,
      position,
      now: deps.now(),
    });
    if ("kind" in result && result.kind === "stale") {
      return answer(ctx, ctx.t("toast-already-rated"));
    }
    if (!("view" in result)) return answer(ctx);
    await answer(ctx, result.buried ? ctx.t("toast-buried") : undefined);
    if (result.view.kind === "summary") {
      await finishAndRender(ctx, deps, result.view);
      return;
    }
    await renderSession(ctx, deps, result.view.session, renderCard(ctx.t.bind(ctx), result.view));
  });

  bot.callbackQuery("s:fin", async (ctx) => {
    const session = await active(ctx);
    if (!session) return answer(ctx, ctx.t("toast-session-gone"));
    await answer(ctx);
    const summary = await deps.sessions.finish({ user: ctx.user, session, now: deps.now() });
    await finishAndRender(ctx, deps, summary);
  });

  bot.callbackQuery("s:rmd", async (ctx) => {
    await answer(ctx);
    deps.events.record(ctx.user.id, "reminder_clicked", {});
    await openSession(ctx, deps);
  });

  bot.callbackQuery("s:cont", async (ctx) => {
    await answer(ctx);
    await openSession(ctx, deps);
  });

  bot.callbackQuery("s:more", async (ctx) => {
    await answer(ctx);
    await openSession(ctx, deps, { extraNew: EXTRA_NEW_BATCH });
  });

  const undo = async (ctx: BotContext): Promise<void> => {
    const session = await active(ctx);
    if (!session) {
      await answer(ctx, ctx.t("toast-nothing-to-undo"));
      return;
    }
    const result = await deps.sessions.undo({ user: ctx.user, session, now: deps.now() });
    if ("kind" in result && result.kind === "nothing") {
      await answer(ctx, ctx.t("toast-nothing-to-undo"));
      return;
    }
    await answer(ctx, ctx.t("toast-undone"));
    await renderSession(ctx, deps, result.session, renderCard(ctx.t.bind(ctx), result));
  };

  bot.callbackQuery("s:undo", undo);
  bot.command("undo", async (ctx) => {
    await undo(ctx);
  });

  bot.callbackQuery(/^c:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const session = await active(ctx);
    if (!parsed || !session) return answer(ctx, ctx.t("toast-session-gone"));
    const position = argInt(parsed, 0);
    if (position === null) return answer(ctx);
    const t = ctx.t.bind(ctx);

    const menu: CardMenuOptions = { canEnrich: deps.add.llm !== null };

    if (parsed.action === "open") {
      if (position !== session.position) return answer(ctx, ctx.t("toast-already-rated"));
      await answer(ctx);
      const view = await deps.sessions.render(session, ctx.user, deps.now(), "actions");
      if (view) await renderSession(ctx, deps, session, renderCard(t, view, menu));
      return;
    }

    /** «✨ Дополнить»: fill in whatever the note is missing, keep the rest. */
    if (parsed.action === "enr") {
      if (position !== session.position) return answer(ctx, ctx.t("toast-already-rated"));
      await answer(ctx, ctx.t("toast-enriching"));
      const view = await deps.sessions.render(session, ctx.user, deps.now(), "question");
      if (!view || !canEnrichCard(view)) return;
      const filled = await deps.add.enrich({
        user: ctx.user,
        noteId: view.card.noteId,
        front: view.card.front,
        now: deps.now(),
      });
      if (filled) {
        deps.events.record(ctx.user.id, "word_generated", {
          cached: filled.cached,
          latencyMs: filled.latencyMs,
          model: deps.add.llm?.model ?? null,
          langFrom: ctx.user.langFrom ?? "en",
          langTo: ctx.user.langTo ?? ctx.user.uiLang,
          via: "enrich",
        });
      }
      const fresh = await deps.sessions.render(session, ctx.user, deps.now(), "question");
      if (fresh) await renderSession(ctx, deps, session, renderCard(t, fresh, menu));
      return;
    }

    if (parsed.action === "know") {
      await markKnown(ctx, position);
      return;
    }

    const actions = { susp: "suspend", bury: "bury", rep: "report", del: "delete" } as const;
    const action = actions[parsed.action as keyof typeof actions];
    if (!action) return answer(ctx);

    const result = await deps.sessions.cardAction({
      user: ctx.user,
      session,
      position,
      action,
      now: deps.now(),
    });
    if ("kind" in result && result.kind === "stale") {
      return answer(ctx, ctx.t("toast-already-rated"));
    }
    const toast = {
      suspend: "toast-suspended",
      bury: "toast-buried",
      report: "toast-reported",
      delete: "toast-deleted",
    }[action];
    if (action === "report") deps.events.record(ctx.user.id, "note_reported", {});
    await answer(ctx, ctx.t(toast));
    if (result.kind === "summary") {
      await finishAndRender(ctx, deps, result);
      return;
    }
    await renderSession(ctx, deps, result.session, renderCard(t, result, menu));
  });

  bot.callbackQuery(/^lch:/u, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    if (!parsed) return answer(ctx);
    const cardId = argInt(parsed, 0);
    if (parsed.action === "susp" && cardId !== null) {
      await deps.sessions.suspendCard(cardId);
      await answer(ctx, ctx.t("toast-suspended"));
    } else {
      await answer(ctx);
    }
    try {
      await ctx.editMessageReplyMarkup({});
    } catch {
      // The notice was already dismissed; nothing to clean up.
    }
  });
}

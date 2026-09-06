import {
  advance,
  buildQueue,
  currentItem,
  isFinished,
  type QueueItem,
  type QueueRepo,
  type QueueState,
  requeueCurrent,
  settle,
} from "../core/queue.js";
import {
  type ApplyResult,
  type CardState,
  createScheduler,
  type Interval,
  type ReviewRating,
} from "../core/scheduler.js";
import { endOfLearningDay, recordActivity, startOfLearningDay } from "../core/streak.js";
import { type UndoRepo, undoLastReview } from "../core/undo.js";
import type {
  CardMode,
  Session,
  SessionStats,
  SuspendedReason,
  TranscriptionMode,
  User,
} from "../db/schema.js";
import { normalizeFrontValue } from "../db/sql.js";
import { isPro } from "./limits.js";

/** Reviews per session before the rest is pushed to a "Продолжить" tap (SPEC §3.1). */
export const SESSION_REVIEW_CAP = 20;
/** More overdue cards than this and the session skips new cards entirely. */
export const SNOWBALL_THRESHOLD = 100;
/** Ratings below this interval are FSRS learning steps: the card comes back now. */
export const SHORT_INTERVAL_MS = 20 * 60_000;
/** "Снова" this many times and the card is called out as a leech. */
export const LEECH_THRESHOLD = 8;
/** An untouched session older than this is abandoned on the next /learn. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** Cards a "Ещё 5 новых" tap adds beyond today's allowance. */
export const EXTRA_NEW_BATCH = 5;
/** Length of the very first session (SPEC §1, step 6). */
export const FIRST_SESSION_SIZE = 5;
/** How many translations «выбор из четырёх» puts on the screen (SPEC §3.2). */
export const CHOICE_OPTIONS = 4;
/**
 * Choice is the *recognition* step of the ladder (SPEC §3.2): exactly one
 * exposure, the first real test, right after «знакомство» — so only while the
 * card has no ratings at all (`reps < 1`). From the first rating on the card
 * goes through the plain reveal flow.
 */
export const CHOICE_MAX_REPS = 1;
/**
 * How long «знакомство» pushes the card away before it is tested (SPEC §3.4).
 * Short enough to stay in the same session, long enough that a couple of other
 * cards come in between; with nothing else left `settle` shows it early.
 */
export const INTRO_RETURN_MS = 60_000;
/** How many notes of the deck we look at when picking distractors. */
export const CHOICE_POOL = 60;
/** Grades «выбор из четырёх» applies for itself: right is Хорошо, wrong is Снова. */
export const CHOICE_RIGHT: ReviewRating = 3;
export const CHOICE_WRONG: ReviewRating = 1;

export interface SessionCardView {
  cardId: number;
  noteId: number;
  deckId: number;
  deckTitle: string;
  /** null for builtin decks — those can be reported but not edited or deleted. */
  deckOwnerId: number | null;
  mode: CardMode;
  front: string;
  back: string;
  transcription: string | null;
  example: string | null;
  exampleTr: string | null;
  /** First tag of the note — the part of speech, used to pick distractors. */
  tag: string | null;
}

/** A note of the same deck offered as a wrong answer (SPEC §3.2). */
export interface ChoiceCandidate {
  noteId: number;
  back: string;
  /** First tag of the note; distractors of the same part of speech read better. */
  tag: string | null;
}

/** One button of the «выбор из четырёх» question, in display order. */
export interface ChoiceOption {
  noteId: number;
  back: string;
}

/**
 * `cards` row as the session service sees it: the FSRS state the scheduler
 * needs, plus `introducedAt` — the durable half of the ladder (SPEC §3.2).
 */
export interface SessionCardState extends CardState {
  /** When «знакомство» was shown for this card, ever; null = never. */
  introducedAt: Date | null;
}

export interface SessionPort {
  queue: QueueRepo;
  undo: UndoRepo;
  findActiveSession(userId: number): Promise<Session | null>;
  findSession(id: number): Promise<Session | null>;
  createSession(input: {
    userId: number;
    deckId: number | null;
    chatId: number;
    queue: QueueItem[];
  }): Promise<Session>;
  saveSession(
    id: number,
    patch: Partial<Pick<Session, "queue" | "position" | "messageId" | "stats" | "messageSentAt">>,
  ): Promise<void>;
  finishSession(id: number, status: "finished" | "abandoned"): Promise<void>;
  cardView(cardId: number): Promise<SessionCardView | null>;
  /** Notes of the same deck that can serve as «выбор из четырёх» distractors. */
  listChoiceCandidates(input: {
    deckId: number;
    excludeNoteId: number;
    tag: string | null;
    limit: number;
  }): Promise<ChoiceCandidate[]>;
  /** Backs of the stored options, so a re-render repeats the same question. */
  listNoteBacks(noteIds: number[]): Promise<ChoiceOption[]>;
  cardState(cardId: number): Promise<SessionCardState | null>;
  /**
   * Stamps «знакомство» on the card row (SPEC §3.2). Only the first
   * presentation is recorded: the mark says the screen happened, ever.
   */
  markIntroduced(cardId: number, at: Date): Promise<void>;
  applyReview(cardId: number, userId: number, result: ApplyResult): Promise<void>;
  setSuspended(cardId: number, suspended: boolean, reason?: SuspendedReason | null): Promise<void>;
  /**
   * Remembers the word as known and suspends every card the user has for it,
   * in any deck (SPEC §3.7). Returns the word, or null when the card is gone.
   */
  markKnown(input: {
    userId: number;
    cardId: number;
  }): Promise<{ front: string; cards: number } | null>;
  setBuried(cardId: number, until: Date | null): Promise<void>;
  deleteNote(noteId: number): Promise<void>;
  reportNote(input: { noteId: number; userId: number; reason?: string | null }): Promise<void>;
  countDue(input: { userId: number; deckId: number | null; now: Date }): Promise<number>;
  nextDue(input: {
    userId: number;
    deckId: number | null;
    now: Date;
  }): Promise<{ at: Date; count: number } | null>;
  listLeeches(input: {
    userId: number;
    cardIds: number[];
    threshold: number;
  }): Promise<Array<{ cardId: number; lapses: number; front: string }>>;
  /** Sum of the per-deck new-card allowances (deck override or user default). */
  newLimitFor(user: User, deckId: number | null): Promise<number>;
  saveStreak(
    userId: number,
    update: { streak: number; lastDay: string | null; freezeDay: string | null },
  ): Promise<void>;
}

/**
 * `intro` is the «знакомство» screen a new card opens with (SPEC §3.2): the
 * word with its translation and example, no question and no rating.
 */
export type SessionStage = "intro" | "question" | "answer" | "actions";

export interface SessionView {
  kind: "card";
  session: Session;
  stage: SessionStage;
  card: SessionCardView;
  isNew: boolean;
  /** 0-based queue index — this is what goes into callback data. */
  position: number;
  /** 1-based counter for "12 / 25". */
  index: number;
  total: number;
  previews: Record<ReviewRating, Interval> | null;
  canUndo: boolean;
  /** Set when new cards were held back because of the review backlog. */
  snowball: boolean;
  /** Where the transcription is shown (user setting). */
  transcriptionMode: TranscriptionMode;
  /** The four «выбор из четырёх» options; null = the plain reveal flow. */
  choices: ChoiceOption[] | null;
  /** Answer screen shown right after a wrong option was tapped (SPEC §3.2). */
  /** Result of a «выбор из четырёх» tap shown on the answer screen; null otherwise. */
  choiceResult: "hit" | "miss" | null;
}

export interface SessionSummary {
  kind: "summary";
  session: Session;
  stats: SessionStats;
  minutes: number;
  accuracy: number;
  streak: number;
  remainingDue: number;
  leech: { cardId: number; front: string } | null;
}

export interface EmptyQueue {
  kind: "empty";
  nextAt: Date | null;
  nextCount: number;
  snowball: boolean;
}

export type StartResult = SessionView | EmptyQueue;

export type RateResult =
  | { kind: "stale" }
  | { kind: "gone" }
  | ({ freezeUsed: boolean; streakExtended: boolean } & (SessionView | SessionSummary));

/** Outcome of a «выбор из четырёх» tap; `correct` drives the toast (SPEC §3.2). */
export type ChooseResult =
  | { kind: "stale" }
  | { kind: "gone" }
  | ({ correct: boolean; freezeUsed: boolean; streakExtended: boolean } & (
      | SessionView
      | SessionSummary
    ));

interface ServiceOptions {
  reviewCap?: number;
  /** Free-plan gating (SPEC §9.1): `choice` is a Pro presentation. */
  proEnabled?: boolean;
}

/** Pure: what the queue looks like after the current card was skipped. */
export function skipCurrent(state: QueueState): { state: QueueState; buried: boolean } {
  const current = currentItem(state);
  if (!current) return { state, buried: false };
  const skipped = current.skipped ?? 0;
  // Second skip means "отложить до завтра": drop it from the queue entirely.
  if (skipped >= 1) return { state: advance(state), buried: true };
  const items = state.items.slice();
  items.push({ ...current, skipped: skipped + 1 });
  return { state: { items, position: state.position + 1 }, buried: false };
}

/**
 * Pure: the in-session half of step one of the ladder (SPEC §3.2) — this queue
 * item has not been presented since the session started. The copy a return
 * inserts carries the flag too, so one item never shows the presentation
 * twice. The card row decides the rest, see `needsIntro`.
 */
export function awaitsIntro(item: QueueItem): boolean {
  return item.isNew && !item.introduced;
}

/**
 * Pure: does this card still owe the user a «знакомство» screen (SPEC §3.2)?
 * Both halves have to agree — the queue item (not presented in this session)
 * and the card row, which has the last word: a card is introduced **once
 * ever**, so `introduced_at` being set sends it straight to the recognition
 * step even in a brand-new session, however the previous one ended.
 */
export function needsIntro(item: QueueItem, state: SessionCardState | null): boolean {
  if (!awaitsIntro(item)) return false;
  return state !== null && state.state === 0 && state.reps === 0 && state.introducedAt === null;
}

/** Pure: undo puts the card back and removes the copy the re-queue inserted. */
export function rewindQueue(state: QueueState, cardId: number): QueueState {
  const position = Math.max(0, state.position - 1);
  const items = state.items.slice();
  const clone = items.findIndex((item, i) => i > position && item.cardId === cardId);
  if (clone >= 0) items.splice(clone, 1);
  return { items, position };
}

/**
 * Deterministic Fisher–Yates. The order of the four options has to survive a
 * re-render — a resumed session, the 48 h "send a new message" fallback — so it
 * comes from the seed rather than from `Math.random`.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  // mulberry32: tiny, fast and stable across Node versions.
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** One shuffle per (session, card): the same card asks the same way twice. */
export function choiceSeed(sessionId: number, cardId: number): number {
  return (Math.imul(sessionId, 0x9e3779b1) ^ Math.imul(cardId, 0x85ebca6b)) >>> 0;
}

/**
 * Wrong answers for one card (SPEC §3.2): notes of the same deck, the same
 * part of speech first, then the ones whose translation is closest in length —
 * an obviously shorter or longer option gives the answer away. Backs that
 * repeat each other or the right answer are dropped: two identical buttons
 * would make the question unanswerable.
 */
export function pickDistractors(input: {
  back: string;
  tag: string | null;
  candidates: readonly ChoiceCandidate[];
  count: number;
}): ChoiceCandidate[] {
  const answer = normalizeFrontValue(input.back);
  const length = input.back.length;
  const sameTag = (candidate: ChoiceCandidate) =>
    input.tag !== null && candidate.tag === input.tag ? 0 : 1;
  const ranked = [...input.candidates].sort((a, b) => {
    const byTag = sameTag(a) - sameTag(b);
    if (byTag !== 0) return byTag;
    const byLength = Math.abs(a.back.length - length) - Math.abs(b.back.length - length);
    if (byLength !== 0) return byLength;
    return a.noteId - b.noteId;
  });

  const picked: ChoiceCandidate[] = [];
  const used = new Set([answer]);
  for (const candidate of ranked) {
    const normalized = normalizeFrontValue(candidate.back);
    if (normalized === "" || used.has(normalized)) continue;
    used.add(normalized);
    picked.push(candidate);
    if (picked.length === input.count) break;
  }
  return picked;
}

const STATS_KEYS = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
} as const satisfies Record<ReviewRating, keyof SessionStats>;

function statsKey(rating: ReviewRating): keyof SessionStats {
  return STATS_KEYS[rating];
}

export function accuracyOf(stats: SessionStats): number {
  return stats.reviewed > 0
    ? Math.round(((stats.reviewed - stats.again) / stats.reviewed) * 100)
    : 0;
}

export function createSessionService(port: SessionPort, options: ServiceOptions = {}) {
  const reviewCap = options.reviewCap ?? SESSION_REVIEW_CAP;
  const proEnabled = options.proEnabled ?? false;

  /** The setting is on and, with `PRO_ENABLED`, the user is actually Pro. */
  function choiceEnabled(user: User, now: Date): boolean {
    if (user.newCardStyle !== "choice") return false;
    return !proEnabled || isPro(user, now);
  }

  /**
   * The four options for this card, or null when the plain reveal flow applies
   * (SPEC §3.2): `recognition` only, only for the one recognition step of the
   * ladder (`reps === 0`, i.e. the card was introduced but never rated), only
   * when the deck yields three usable distractors, and only when the setting is
   * on. The chosen ids are frozen in the queue item, so a resumed session — or
   * a re-render after the 48 h edit window — asks the same question in the same
   * order.
   */
  async function choicesFor(
    session: Session,
    user: User,
    card: SessionCardView,
    item: QueueItem,
    state: CardState | null,
    now: Date,
  ): Promise<ChoiceOption[] | null> {
    if (card.mode !== "recognition" || !choiceEnabled(user, now)) return null;
    if (!state || state.reps >= CHOICE_MAX_REPS) return null;

    if (item.choice) {
      const backs = new Map(
        (await port.listNoteBacks(item.choice.noteIds)).map((option) => [
          option.noteId,
          option.back,
        ]),
      );
      const stored = item.choice.noteIds.map((noteId) => ({
        noteId,
        back: backs.get(noteId) ?? null,
      }));
      // A note may have been deleted meanwhile; then the question is rebuilt.
      if (stored.every((option) => option.back !== null)) {
        return stored as ChoiceOption[];
      }
    }

    const candidates = await port.listChoiceCandidates({
      deckId: card.deckId,
      excludeNoteId: card.noteId,
      tag: card.tag,
      limit: CHOICE_POOL,
    });
    const distractors = pickDistractors({
      back: card.back,
      tag: card.tag,
      candidates,
      count: CHOICE_OPTIONS - 1,
    });
    // A deck of fewer than four usable notes cannot ask this question.
    if (distractors.length < CHOICE_OPTIONS - 1) return null;

    const options = seededShuffle(
      [
        { noteId: card.noteId, back: card.back },
        ...distractors.map((note) => ({ noteId: note.noteId, back: note.back })),
      ],
      choiceSeed(session.id, card.cardId),
    );
    item.choice = { noteIds: options.map((option) => option.noteId) };
    await port.saveSession(session.id, { queue: session.queue });
    return options;
  }

  async function viewAt(
    session: Session,
    user: User,
    now: Date,
    stage: SessionStage,
    extras: { snowball?: boolean; canUndo?: boolean } = {},
  ): Promise<SessionView | null> {
    const item = session.queue[session.position];
    if (!item) return null;
    const card = await port.cardView(item.cardId);
    if (!card) return null;

    // One read of the card state serves the ladder, the choice options and the
    // interval previews.
    let cached: SessionCardState | null | undefined;
    const cardState = async (): Promise<SessionCardState | null> => {
      if (cached === undefined) cached = await port.cardState(item.cardId);
      return cached;
    };

    // Step one of the ladder (SPEC §3.2): a card that was never presented and
    // never rated opens with «знакомство», never with a question. A stale
    // «Показать ответ» for such an item lands here too and simply re-renders
    // the intro screen. A card whose `introduced_at` is already set skips
    // straight to step two — the recognition step, i.e. «выбор из четырёх»
    // while the style and the deck allow it, otherwise the plain reveal.
    if ((stage === "question" || stage === "answer") && awaitsIntro(item)) {
      if (needsIntro(item, await cardState())) stage = "intro";
    }

    const choices =
      stage === "question"
        ? await choicesFor(session, user, card, item, await cardState(), now)
        : null;
    let previews: Record<ReviewRating, Interval> | null = null;
    if (stage === "answer" && user.showIntervals) {
      const state = await cardState();
      if (state) {
        const scheduler = createScheduler(user.desiredRetention);
        const preview = scheduler.previewIntervals(state, now);
        previews = {
          1: preview[1].interval,
          2: preview[2].interval,
          3: preview[3].interval,
          4: preview[4].interval,
        };
      }
    }
    return {
      kind: "card",
      session,
      stage,
      card,
      isNew: item.isNew,
      position: session.position,
      index: session.position + 1,
      total: session.queue.length,
      previews,
      canUndo: extras.canUndo ?? session.stats.reviewed > 0,
      snowball: extras.snowball ?? false,
      transcriptionMode: user.transcriptionMode,
      choices,
      choiceResult: null,
    };
  }

  /** The schema allows one active session per user, so make room before creating one. */
  async function closeActive(userId: number): Promise<void> {
    const active = await port.findActiveSession(userId);
    if (active) await port.finishSession(active.id, "finished");
  }

  async function summarize(session: Session, now: Date, streak: number): Promise<SessionSummary> {
    const cardIds = [...new Set(session.queue.map((item) => item.cardId))];
    const [leeches, remainingDue] = await Promise.all([
      port.listLeeches({ userId: session.userId, cardIds, threshold: LEECH_THRESHOLD }),
      port.countDue({ userId: session.userId, deckId: session.deckId, now }),
    ]);
    const leech = leeches[0];
    return {
      kind: "summary",
      session,
      stats: session.stats,
      minutes: Math.max(1, Math.round((now.getTime() - session.startedAt.getTime()) / 60_000)),
      accuracy: accuracyOf(session.stats),
      streak,
      remainingDue,
      leech: leech ? { cardId: leech.cardId, front: leech.front } : null,
    };
  }

  /**
   * Everything one rating changes (SPEC §3.6): FSRS, the undo snapshot, the
   * queue, the session counters and the streak — in that order. Shared by the
   * rating buttons and by «выбор из четырёх», which grades itself. The session
   * is deliberately *not* finished here: what to show when the queue drains
   * depends on how the rating was given. Returns null when the card is gone.
   */
  async function applyRating(input: {
    user: User;
    session: Session;
    item: QueueItem;
    position: number;
    rating: ReviewRating;
    now: Date;
  }): Promise<{
    session: Session;
    streak: number;
    freezeUsed: boolean;
    streakExtended: boolean;
    finished: boolean;
  } | null> {
    const { user, session, item, position, rating, now } = input;
    const state = await port.cardState(item.cardId);
    if (!state) return null;

    const scheduler = createScheduler(user.desiredRetention);
    const result = scheduler.applyRating(state, rating, now);
    await port.applyReview(item.cardId, user.id, result);

    const stats: SessionStats = {
      ...session.stats,
      reviewed: session.stats.reviewed + 1,
      newLearned: session.stats.newLearned + (item.isNew ? 1 : 0),
    };
    stats[statsKey(rating)] += 1;

    const short = result.card.due.getTime() - now.getTime() < SHORT_INTERVAL_MS;
    const next = settle(
      short
        ? requeueCurrent({ items: session.queue, position }, result.card.due.getTime())
        : advance({ items: session.queue, position }),
      now,
    );

    await port.saveSession(session.id, {
      queue: next.items,
      position: next.position,
      stats,
    });

    const streakBefore = {
      streak: user.streak,
      lastDay: user.streakLastDay,
      freezeDay: user.streakFreezeDay,
    };
    const streak = recordActivity(streakBefore, now, user.tz);
    if (streak.lastDay !== streakBefore.lastDay || streak.streak !== streakBefore.streak) {
      await port.saveStreak(user.id, streak);
    }

    return {
      session: { ...session, queue: next.items, position: next.position, stats },
      streak: streak.streak,
      freezeUsed: streak.freezeUsed,
      streakExtended: streak.extended,
      finished: isFinished(next),
    };
  }

  /** The screen a finished rating leads to: the next card, or the summary. */
  async function afterRating(
    applied: { session: Session; streak: number; finished: boolean },
    user: User,
    now: Date,
  ): Promise<SessionView | SessionSummary> {
    if (!applied.finished) {
      const view = await viewAt(applied.session, user, now, "question");
      if (view) return view;
    }
    await port.finishSession(applied.session.id, "finished");
    return summarize(applied.session, now, applied.streak);
  }

  return {
    /** Active session, or null after abandoning one that went stale. */
    async current(user: User, now: Date): Promise<Session | null> {
      const session = await port.findActiveSession(user.id);
      if (!session) return null;
      if (now.getTime() - session.startedAt.getTime() > SESSION_IDLE_MS) {
        await port.finishSession(session.id, "abandoned");
        return null;
      }
      return session;
    },

    /**
     * Builds a queue and opens a session. `extraNew` bypasses today's allowance
     * ("Ещё 5 новых"); `newLimit` overrides it outright (first session).
     */
    async start(input: {
      user: User;
      deckId: number | null;
      chatId: number;
      now: Date;
      newLimit?: number;
      extraNew?: number;
    }): Promise<StartResult> {
      const { user, deckId, now } = input;
      // Only one active session per user is allowed by the schema; opening a
      // new one supersedes whatever was still open.
      await closeActive(user.id);
      const dayStart = startOfLearningDay(now, user.tz);
      const overdue = await port.countDue({ userId: user.id, deckId, now });
      const snowball = overdue > SNOWBALL_THRESHOLD;

      let dailyNewLimit = input.newLimit ?? (await port.newLimitFor(user, deckId));
      if (snowball && input.extraNew === undefined) dailyNewLimit = 0;

      const built = await buildQueue(port.queue, {
        userId: user.id,
        deckId,
        now,
        dayStart,
        dailyNewLimit,
        maxReviews: reviewCap,
      });

      if (input.extraNew !== undefined && input.extraNew > 0) {
        // "Ещё 5 новых" — a one-off overrun of today's allowance. `dayStart: now`
        // makes the builder ignore what was already introduced today, and the
        // limit stays at `extraNew` so it materializes exactly that many cards.
        const extra = await buildQueue(port.queue, {
          userId: user.id,
          deckId,
          now,
          dayStart: now,
          dailyNewLimit: input.extraNew,
          maxReviews: 0,
        });
        const seen = new Set(built.items.map((item) => item.cardId));
        for (const item of extra.items) {
          if (seen.has(item.cardId)) continue;
          built.items.push(item);
          seen.add(item.cardId);
        }
      }

      if (built.items.length === 0) {
        const next = await port.nextDue({ userId: user.id, deckId, now });
        return {
          kind: "empty",
          nextAt: next?.at ?? null,
          nextCount: next?.count ?? 0,
          snowball,
        };
      }

      const session = await port.createSession({
        userId: user.id,
        deckId,
        chatId: input.chatId,
        queue: built.items,
      });
      const view = await viewAt(session, user, now, "question", { snowball, canUndo: false });
      return view ?? { kind: "empty", nextAt: null, nextCount: 0, snowball };
    },

    /** Re-renders the session at its stored position (source of truth is the DB). */
    async render(
      session: Session,
      user: User,
      now: Date,
      stage: SessionStage = "question",
    ): Promise<SessionView | null> {
      // On resume a learning card may have become due, or another card may
      // now be preferable; persist the reorder so callbacks see the same queue.
      const settled = settle({ items: session.queue, position: session.position }, now);
      if (settled.items !== session.queue) {
        await port.saveSession(session.id, { queue: settled.items, position: settled.position });
        return viewAt({ ...session, queue: settled.items }, user, now, stage);
      }
      return viewAt(session, user, now, stage);
    },

    /**
     * «▶️ Дальше» on the «знакомство» screen (SPEC §3.2, §3.4). This is not a
     * rating: no FSRS, no `review_logs`, no session counters. The card is
     * marked as introduced and put back into the session a minute later for
     * its first real test; with nothing else left `settle` shows it early.
     * `cardId` is null when the tap came from an outdated screen — then the
     * current screen is simply re-rendered.
     */
    async introduce(input: {
      user: User;
      session: Session;
      position: number;
      now: Date;
    }): Promise<{ view: SessionView | SessionSummary; cardId: number | null } | { kind: "stale" }> {
      const { user, session, position, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      if (!needsIntro(item, await port.cardState(item.cardId))) {
        const stale = await viewAt(session, user, now, "question");
        return stale ? { view: stale, cardId: null } : { kind: "stale" };
      }

      // Persisted on the card, not only on the session: the presentation
      // happens once ever (SPEC §3.2), so a session that ends before the first
      // rating — «Закончить», an abandoned session, a returned copy nobody got
      // to — does not offer it again tomorrow.
      await port.markIntroduced(item.cardId, now);
      // The copy carries `introduced`, and so does the item left behind: a
      // rewind (`/undo`) must never bring the presentation screen back.
      item.introduced = true;
      const next = settle(
        requeueCurrent({ items: session.queue, position }, now.getTime() + INTRO_RETURN_MS, {
          intro: true,
        }),
        now,
      );
      await port.saveSession(session.id, { queue: next.items, position: next.position });
      const updated: Session = { ...session, queue: next.items, position: next.position };
      if (!isFinished(next)) {
        const view = await viewAt(updated, user, now, "question");
        if (view) return { view, cardId: item.cardId };
      }
      await port.finishSession(session.id, "finished");
      return { view: await summarize(updated, now, user.streak), cardId: item.cardId };
    },

    /** Records a rating. `position` comes from the button and guards double taps. */
    async rate(input: {
      user: User;
      session: Session;
      position: number;
      rating: ReviewRating;
      now: Date;
    }): Promise<RateResult> {
      const { user, session, position, rating, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const applied = await applyRating({ user, session, item, position, rating, now });
      if (!applied) return { kind: "gone" };
      return {
        ...(await afterRating(applied, user, now)),
        freezeUsed: applied.freezeUsed,
        streakExtended: applied.streakExtended,
      };
    },

    /**
     * «Выбор из четырёх» (SPEC §3.2): the tapped option grades itself — right
     * is «Хорошо», wrong is «Снова» — and goes through the very same path as a
     * rating button, undo included. Both outcomes stop on the answer screen
     * («✅ Верно» / «❌ Неверно. Правильно: …») before «Дальше».
     */
    async choose(input: {
      user: User;
      session: Session;
      position: number;
      option: number;
      now: Date;
    }): Promise<ChooseResult> {
      const { user, session, position, option, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      const noteId = item?.choice?.noteIds[option];
      if (!item || noteId === undefined) return { kind: "stale" };
      const card = await port.cardView(item.cardId);
      if (!card) return { kind: "gone" };

      const correct = noteId === card.noteId;
      const isNew = item.isNew;
      const applied = await applyRating({
        user,
        session,
        item,
        position,
        rating: correct ? CHOICE_RIGHT : CHOICE_WRONG,
        now,
      });
      if (!applied) return { kind: "gone" };
      const meta = {
        correct,
        freezeUsed: applied.freezeUsed,
        streakExtended: applied.streakExtended,
      };
      // The rating is already saved and, on a miss, the card is already back in
      // the queue for its learning step. Both outcomes stop on the answer
      // screen so the translation and the example get read; the session is
      // finished by «Дальше», not here, so the queue can drain without
      // swallowing the last card.
      return {
        kind: "card",
        session: applied.session,
        stage: "answer",
        card,
        isNew,
        position: applied.session.position,
        index: position + 1,
        total: applied.session.queue.length,
        previews: null,
        canUndo: true,
        snowball: false,
        transcriptionMode: user.transcriptionMode,
        choices: null,
        choiceResult: correct ? "hit" : "miss",
        ...meta,
      };
    },

    /** «Дальше ▶️» after a miss: the rating is done, just move the session on. */
    async next(input: {
      user: User;
      session: Session;
      position: number;
      now: Date;
    }): Promise<SessionView | SessionSummary | { kind: "stale" }> {
      const { user, session, position, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const settled = settle({ items: session.queue, position: session.position }, now);
      if (settled.items !== session.queue) {
        await port.saveSession(session.id, { queue: settled.items, position: settled.position });
      }
      const updated: Session = { ...session, queue: settled.items, position: settled.position };
      if (!isFinished(settled)) {
        const view = await viewAt(updated, user, now, "question");
        if (view) return view;
      }
      await port.finishSession(session.id, "finished");
      return summarize(updated, now, user.streak);
    },

    /** Pushes the card to the end of the queue; the second skip buries it. */
    async skip(input: {
      user: User;
      session: Session;
      position: number;
      now: Date;
    }): Promise<{ view: SessionView | SessionSummary; buried: boolean } | { kind: "stale" }> {
      const { user, session, position, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const { state: skippedState, buried } = skipCurrent({ items: session.queue, position });
      const next = settle(skippedState, now);
      if (buried) await port.setBuried(item.cardId, endOfLearningDay(now, user.tz));
      await port.saveSession(session.id, { queue: next.items, position: next.position });
      const updated: Session = { ...session, queue: next.items, position: next.position };
      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return { view: await summarize(updated, now, user.streak), buried };
      }
      const view = await viewAt(updated, user, now, "question");
      if (!view) {
        await port.finishSession(session.id, "finished");
        return { view: await summarize(updated, now, user.streak), buried };
      }
      return { view, buried };
    },

    async finish(input: { user: User; session: Session; now: Date }): Promise<SessionSummary> {
      await port.finishSession(input.session.id, "finished");
      return summarize(input.session, input.now, input.user.streak);
    },

    /**
     * Rolls the last rating back (depth 1) and makes that card current again.
     * Only ratings that belong to this session can be undone.
     */
    async undo(input: {
      user: User;
      session: Session;
      now: Date;
    }): Promise<SessionView | { kind: "nothing" }> {
      const { user, session, now } = input;
      if (session.stats.reviewed === 0) return { kind: "nothing" };
      const result = await undoLastReview(port.undo, user.id);
      if (!result) return { kind: "nothing" };

      const next = rewindQueue({ items: session.queue, position: session.position }, result.cardId);
      const item = next.items[next.position];
      const stats: SessionStats = { ...session.stats };
      stats.reviewed = Math.max(0, stats.reviewed - 1);
      const key = statsKey(result.rating as ReviewRating);
      stats[key] = Math.max(0, stats[key] - 1);
      if (result.wasNew) stats.newLearned = Math.max(0, stats.newLearned - 1);
      if (item) item.isNew = result.wasNew;

      await port.saveSession(session.id, {
        queue: next.items,
        position: next.position,
        stats,
      });
      const updated: Session = {
        ...session,
        queue: next.items,
        position: next.position,
        stats,
      };
      const view = await viewAt(updated, user, now, "question", { canUndo: false });
      return view ?? { kind: "nothing" };
    },

    /**
     * «✅ Знаю»: the word is switched off everywhere and the session moves on.
     * No rating, no review log, nothing added to `stats.reviewed` — this is not
     * a repetition (SPEC §3.7).
     */
    async markKnown(input: {
      user: User;
      session: Session;
      position: number;
      now: Date;
    }): Promise<{ view: SessionView | SessionSummary; word: string } | { kind: "stale" }> {
      const { user, session, position, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const known = await port.markKnown({ userId: user.id, cardId: item.cardId });
      if (!known) return { kind: "stale" };

      // Like a rating, the queue moves on — so a second tap on the same
      // position is stale. Re-queued copies of the card are dropped.
      const items = session.queue.filter(
        (queued, i) => i <= position || queued.cardId !== item.cardId,
      );
      const next = settle({ items, position: position + 1 }, now);
      await port.saveSession(session.id, { queue: next.items, position: next.position });
      const updated: Session = { ...session, queue: next.items, position: next.position };
      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return { view: await summarize(updated, now, user.streak), word: known.front };
      }
      const view = await viewAt(updated, user, now, "question");
      if (view) return { view, word: known.front };
      await port.finishSession(session.id, "finished");
      return { view: await summarize(updated, now, user.streak), word: known.front };
    },

    /** Card-actions menu: suspend / bury / report / delete, then move on. */
    async cardAction(input: {
      user: User;
      session: Session;
      position: number;
      action: "suspend" | "bury" | "report" | "delete";
      now: Date;
    }): Promise<SessionView | SessionSummary | { kind: "stale" }> {
      const { user, session, position, action, now } = input;
      if (position !== session.position) return { kind: "stale" };
      const item = session.queue[position];
      if (!item) return { kind: "stale" };
      const card = await port.cardView(item.cardId);
      if (!card) return { kind: "stale" };

      if (action === "suspend") await port.setSuspended(item.cardId, true, "manual");
      if (action === "bury") await port.setBuried(item.cardId, endOfLearningDay(now, user.tz));
      if (action === "report") {
        await port.reportNote({ noteId: card.noteId, userId: user.id });
      }
      if (action === "delete") await port.deleteNote(card.noteId);

      if (action === "report") {
        const view = await viewAt(session, user, now, "question");
        return view ?? (await summarize(session, now, user.streak));
      }

      // The card leaves the session: drop every occurrence of it from the queue.
      const items = session.queue.filter(
        (queued, i) => queued.cardId !== item.cardId || i < position,
      );
      const next: QueueState = { items, position };
      await port.saveSession(session.id, { queue: items, position });
      const updated: Session = { ...session, queue: items, position };
      if (isFinished(next)) {
        await port.finishSession(session.id, "finished");
        return summarize(updated, now, user.streak);
      }
      const view = await viewAt(updated, user, now, "question");
      return view ?? (await summarize(updated, now, user.streak));
    },

    /**
     * Opens a session over an explicit list of cards — used by "Учить сейчас",
     * which pulls one card in outside the daily new-card allowance (SPEC §4.1).
     */
    async startWith(input: {
      user: User;
      chatId: number;
      deckId: number | null;
      cardIds: number[];
      now: Date;
    }): Promise<SessionView | null> {
      await closeActive(input.user.id);
      const items: QueueItem[] = [];
      for (const cardId of input.cardIds) {
        const state = await port.cardState(cardId);
        if (!state) continue;
        items.push({ cardId, isNew: state.state === 0 });
      }
      if (items.length === 0) return null;
      const session = await port.createSession({
        userId: input.user.id,
        deckId: input.deckId,
        chatId: input.chatId,
        queue: items,
      });
      return viewAt(session, input.user, input.now, "question", { canUndo: false });
    },

    /** Suspends a leech straight from the post-session notice. */
    async suspendCard(cardId: number): Promise<void> {
      await port.setSuspended(cardId, true, "leech");
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

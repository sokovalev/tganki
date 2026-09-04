import {
  createEmptyCard,
  type FSRS,
  type Card as FsrsCard,
  fsrs,
  type Grade,
  Rating,
  State,
} from "ts-fsrs";

export { Rating, State };

/** The four grades a user can give. Mirrors ts-fsrs `Grade` (Manual is not exposed). */
export type ReviewRating = 1 | 2 | 3 | 4;

export const REVIEW_RATINGS: readonly ReviewRating[] = [1, 2, 3, 4];

/**
 * The scheduling half of a `cards` row, decoupled from the DB layer so the
 * scheduler stays a pure function of card state.
 */
export interface CardState {
  state: number;
  stability: number;
  difficulty: number;
  due: Date;
  lastReview: Date | null;
  reps: number;
  lapses: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
}

/** Everything a `review_logs` row needs, minus the ids. */
export interface ReviewSnapshot {
  rating: ReviewRating;
  reviewedAt: Date;
  stateBefore: number;
  stabilityBefore: number;
  difficultyBefore: number;
  dueBefore: Date;
  lastReviewBefore: Date | null;
  repsBefore: number;
  lapsesBefore: number;
  learningStepsBefore: number;
  elapsedDaysBefore: number;
  /** Days since the previous review (Anki revlog semantics, fsrs-optimizer input). */
  elapsedDays: number;
  /** Interval the card was scheduled for before this review. */
  scheduledDays: number;
}

export type IntervalUnit = "minute" | "hour" | "day" | "month" | "year";

/** Structured interval so the bot layer can render it in the user's language. */
export interface Interval {
  unit: IntervalUnit;
  value: number;
}

export interface RatingPreview {
  rating: ReviewRating;
  due: Date;
  interval: Interval;
}

export interface ApplyResult {
  card: CardState;
  log: ReviewSnapshot;
}

export interface Scheduler {
  /** State of a card that has never been reviewed. */
  newCard(now: Date): CardState;
  /** Next due date + interval label for each of the four ratings. */
  previewIntervals(card: CardState, now: Date): Record<ReviewRating, RatingPreview>;
  /** New card state plus the log row that can undo this review. */
  applyRating(card: CardState, rating: ReviewRating, now: Date): ApplyResult;
  readonly fsrs: FSRS;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Card states in which a card should come back inside the same session. */
export function isLearning(card: Pick<CardState, "state">): boolean {
  return card.state === State.Learning || card.state === State.Relearning;
}

export function toFsrsCard(card: CardState): FsrsCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    ...(card.lastReview ? { last_review: card.lastReview } : {}),
  };
}

export function fromFsrsCard(card: FsrsCard): CardState {
  return {
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    due: card.due,
    lastReview: card.last_review ?? null,
    reps: card.reps,
    lapses: card.lapses,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
  };
}

/**
 * Turns a duration into the `{unit, value}` pair shown under a rating button.
 * Anything below a minute is reported as one minute (rendered as "<1m").
 */
export function describeInterval(ms: number): Interval {
  const round = (x: number) => Math.round(x * 10) / 10;
  if (ms < HOUR) return { unit: "minute", value: Math.max(1, Math.round(ms / MINUTE)) };
  if (ms < DAY) return { unit: "hour", value: Math.round(ms / HOUR) };
  if (ms < MONTH) return { unit: "day", value: Math.round(ms / DAY) };
  if (ms < YEAR) return { unit: "month", value: round(ms / MONTH) };
  return { unit: "year", value: round(ms / YEAR) };
}

/**
 * FSRS scheduler. Learning steps come from ts-fsrs defaults: 1m → 10m for
 * learning, 10m for relearning (`default_learning_steps`).
 */
export function createScheduler(desiredRetention = 0.9): Scheduler {
  const f = fsrs({ request_retention: desiredRetention, enable_fuzz: true });

  return {
    fsrs: f,

    newCard(now: Date): CardState {
      return fromFsrsCard(createEmptyCard(now));
    },

    previewIntervals(card: CardState, now: Date): Record<ReviewRating, RatingPreview> {
      const preview = f.repeat(toFsrsCard(card), now);
      const entry = (rating: ReviewRating): RatingPreview => {
        const due = preview[rating as Grade].card.due;
        return { rating, due, interval: describeInterval(due.getTime() - now.getTime()) };
      };
      return { 1: entry(1), 2: entry(2), 3: entry(3), 4: entry(4) };
    },

    applyRating(card: CardState, rating: ReviewRating, now: Date): ApplyResult {
      const { card: next, log } = f.next(toFsrsCard(card), now, rating as Grade);
      return {
        card: fromFsrsCard(next),
        log: {
          rating,
          reviewedAt: now,
          stateBefore: card.state,
          stabilityBefore: card.stability,
          difficultyBefore: card.difficulty,
          dueBefore: card.due,
          lastReviewBefore: card.lastReview,
          repsBefore: card.reps,
          lapsesBefore: card.lapses,
          learningStepsBefore: card.learningSteps,
          elapsedDaysBefore: card.elapsedDays,
          // Actual gap since the previous review and the interval the card was
          // scheduled for: these two are what fsrs-optimizer consumes.
          elapsedDays: log.elapsed_days,
          scheduledDays: log.scheduled_days,
        },
      };
    },
  };
}

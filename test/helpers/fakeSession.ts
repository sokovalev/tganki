import type { CardState } from "../../src/core/scheduler.js";
import type { ReviewLogSnapshot } from "../../src/core/undo.js";
import type { CardMode, Session, SuspendedReason, User } from "../../src/db/schema.js";
import type { SessionCardView, SessionPort } from "../../src/services/sessionService.js";

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    tgId: 555,
    uiLang: "ru",
    tz: "Europe/Moscow",
    dailyNewLimit: 10,
    reminderTime: null,
    plan: "free",
    planUntil: null,
    streak: 3,
    streakLastDay: null,
    streakFreezeDay: null,
    streakBest: 5,
    langFrom: "en",
    langTo: "ru",
    onboardingStep: null,
    blockedAt: null,
    lastRemindedDay: null,
    showIntervals: true,
    transcriptionMode: "answer",
    newCardStyle: "choice",
    desiredRetention: 0.9,
    pendingInput: null,
    pendingInputExpiresAt: null,
    pendingPayload: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

export interface FakeCard {
  id: number;
  noteId: number;
  deckId: number;
  deckTitle: string;
  /** Learning language of the deck the note lives in. */
  langFrom: string;
  deckOwnerId: number | null;
  mode: CardMode;
  front: string;
  back: string;
  transcription: string | null;
  example: string | null;
  exampleTr: string | null;
  /** First tag of the note — what «выбор из четырёх» matches on (SPEC §3.2). */
  tag: string | null;
  state: CardState;
  suspended: boolean;
  suspendedReason: SuspendedReason | null;
  buriedUntil: Date | null;
}

/** The JS twin of `frontNorm` in `src/db/sql.ts`. */
export function normalizeFront(front: string): string {
  return front.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function makeCard(id: number, now: Date, overrides: Partial<FakeCard> = {}): FakeCard {
  return {
    id,
    noteId: 100 + id,
    deckId: 1,
    deckTitle: "English Top 1000 · A2",
    langFrom: "en",
    deckOwnerId: null,
    mode: "recognition",
    front: `word${id}`,
    back: `перевод${id}`,
    transcription: null,
    example: null,
    exampleTr: null,
    tag: null,
    state: {
      state: 0,
      stability: 0,
      difficulty: 0,
      due: now,
      lastReview: null,
      reps: 0,
      lapses: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
    },
    suspended: false,
    suspendedReason: null,
    buriedUntil: null,
    ...overrides,
  };
}

/** A note of a deck that has no card of its own — a distractor fixture. */
export interface FakeNote {
  noteId: number;
  deckId: number;
  back: string;
  tag: string | null;
}

export interface FakeState {
  cards: Map<number, FakeCard>;
  /**
   * Notes «выбор из четырёх» may draw distractors from (SPEC §3.2). Empty by
   * default: a deck of fewer than four notes cannot ask that question, so
   * every test that does not set this stays on the plain reveal flow.
   */
  deckNotes: FakeNote[];
  sessions: Session[];
  logs: ReviewLogSnapshot[];
  deletedNotes: number[];
  reports: Array<{ noteId: number; userId: number }>;
  /** Extra cards the queue builder may introduce as new. */
  newCandidateIds: number[];
  /** Words switched off with "✅ Знаю", as `lang_from` + normalized front. */
  knownWords: Array<{ langFrom: string; frontNorm: string }>;
  introducedToday: number;
  /** When today's new cards were introduced, so `since` filtering behaves like SQL. */
  introducedAt: Date;
  remainingDue: number;
  newLimit: number;
  streakSaves: Array<{ streak: number; lastDay: string | null }>;
  nextDue: { at: Date; count: number } | null;
  nextSessionId: number;
  nextLogId: number;
}

function isKnown(state: FakeState, langFrom: string, frontNorm: string): boolean {
  return state.knownWords.some(
    (word) => word.langFrom === langFrom && word.frontNorm === frontNorm,
  );
}

/** True when another note carries the same word in the same learning language. */
function hasOtherCard(state: FakeState, candidate: FakeCard): boolean {
  const front = normalizeFront(candidate.front);
  for (const card of state.cards.values()) {
    if (card.noteId === candidate.noteId) continue;
    if (card.langFrom !== candidate.langFrom) continue;
    if (normalizeFront(card.front) === front) return true;
  }
  return false;
}

export function createFakePort(cards: FakeCard[], options: Partial<FakeState> = {}) {
  const state: FakeState = {
    cards: new Map(cards.map((card) => [card.id, card])),
    deckNotes: [],
    sessions: [],
    logs: [],
    deletedNotes: [],
    reports: [],
    newCandidateIds: [],
    knownWords: [],
    introducedToday: 0,
    introducedAt: new Date(0),
    remainingDue: 0,
    newLimit: 10,
    streakSaves: [],
    nextDue: null,
    nextSessionId: 1,
    nextLogId: 1,
    ...options,
  };

  const view = (card: FakeCard): SessionCardView => ({
    cardId: card.id,
    noteId: card.noteId,
    deckId: card.deckId,
    deckTitle: card.deckTitle,
    deckOwnerId: card.deckOwnerId,
    mode: card.mode,
    front: card.front,
    back: card.back,
    transcription: card.transcription,
    example: card.example,
    exampleTr: card.exampleTr,
    tag: card.tag,
  });

  /** Every note the fake knows: the deck fixtures plus each card's own note. */
  const noteRows = (): FakeNote[] => [
    ...state.deckNotes,
    ...[...state.cards.values()].map((card) => ({
      noteId: card.noteId,
      deckId: card.deckId,
      back: card.back,
      tag: card.tag,
    })),
  ];

  const port: SessionPort = {
    queue: {
      async listDueCards({ now, limit }) {
        return [...state.cards.values()]
          .filter(
            (card) =>
              !card.suspended &&
              card.state.state !== 0 &&
              card.state.due.getTime() <= now.getTime() &&
              (card.buriedUntil === null || card.buriedUntil.getTime() <= now.getTime()),
          )
          .sort((a, b) => a.state.due.getTime() - b.state.due.getTime())
          .slice(0, limit)
          .map((card) => ({ cardId: card.id, due: card.state.due }));
      },
      async listNewCandidates({ limit }) {
        // Mirrors the SQL in `cards.listNewCandidates`: known words and words
        // the user already learns through another deck are not candidates.
        return state.newCandidateIds
          .filter((cardId) => {
            const card = state.cards.get(cardId);
            if (!card) return true;
            const front = normalizeFront(card.front);
            if (isKnown(state, card.langFrom, front)) return false;
            return !hasOtherCard(state, card);
          })
          .slice(0, limit)
          .map((cardId, index) => ({
            noteId: state.cards.get(cardId)?.noteId ?? 1000 + cardId,
            deckId: 1,
            mode: "recognition" as CardMode,
            position: index,
            cardId,
          }));
      },
      async countNewIntroducedSince({ since }) {
        return state.introducedAt.getTime() >= since.getTime() ? state.introducedToday : 0;
      },
      async createCard({ noteId }) {
        const id = Math.max(0, ...state.cards.keys()) + 1;
        state.cards.set(id, { ...makeCard(id, new Date()), noteId });
        return id;
      },
    },

    undo: {
      async findLastReview(userId) {
        const own = state.logs.filter((log) => log.userId === userId);
        return own[own.length - 1] ?? null;
      },
      async revert(log, card) {
        const row = state.cards.get(log.cardId);
        if (row) row.state = card;
        state.logs = state.logs.filter((entry) => entry.id !== log.id);
      },
    },

    async findActiveSession(userId) {
      return (
        state.sessions.find(
          (session) => session.userId === userId && session.status === "active",
        ) ?? null
      );
    },

    async findSession(id) {
      return state.sessions.find((session) => session.id === id) ?? null;
    },

    async createSession(input) {
      const session: Session = {
        id: state.nextSessionId++,
        userId: input.userId,
        deckId: input.deckId,
        chatId: input.chatId,
        messageId: null,
        messageSentAt: null,
        status: "active",
        queue: input.queue,
        position: 0,
        startedAt: new Date("2026-01-10T12:00:00.000Z"),
        finishedAt: null,
        stats: { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, newLearned: 0 },
      };
      state.sessions.push(session);
      return session;
    },

    async saveSession(id, patch) {
      const session = state.sessions.find((row) => row.id === id);
      if (session) Object.assign(session, patch);
    },

    async finishSession(id, status) {
      const session = state.sessions.find((row) => row.id === id);
      if (session) {
        session.status = status;
        session.finishedAt = new Date();
      }
    },

    async cardView(cardId) {
      const card = state.cards.get(cardId);
      return card ? view(card) : null;
    },

    async listChoiceCandidates({ deckId, excludeNoteId, tag, limit }) {
      // Mirrors the SQL: same deck, never the note itself, same first tag first.
      return state.deckNotes
        .filter((note) => note.deckId === deckId && note.noteId !== excludeNoteId)
        .sort((a, b) => Number(b.tag === tag) - Number(a.tag === tag))
        .slice(0, limit)
        .map((note) => ({ noteId: note.noteId, back: note.back, tag: note.tag }));
    },

    async listNoteBacks(noteIds) {
      const rows = noteRows();
      return noteIds
        .map((noteId) => rows.find((note) => note.noteId === noteId))
        .filter((note): note is FakeNote => note !== undefined)
        .map((note) => ({ noteId: note.noteId, back: note.back }));
    },

    async cardState(cardId) {
      const card = state.cards.get(cardId);
      return card ? { ...card.state } : null;
    },

    async applyReview(cardId, userId, result) {
      const card = state.cards.get(cardId);
      if (!card) return;
      state.logs.push({ id: state.nextLogId++, cardId, userId, ...result.log });
      card.state = result.card;
    },

    async setSuspended(cardId, suspended, reason = null) {
      const card = state.cards.get(cardId);
      if (card) {
        card.suspended = suspended;
        card.suspendedReason = suspended ? reason : null;
      }
    },

    async markKnown({ cardId }) {
      const card = state.cards.get(cardId);
      if (!card) return null;
      const frontNorm = normalizeFront(card.front);
      if (!isKnown(state, card.langFrom, frontNorm)) {
        state.knownWords.push({ langFrom: card.langFrom, frontNorm });
      }
      let suspended = 0;
      for (const row of state.cards.values()) {
        if (row.langFrom !== card.langFrom || normalizeFront(row.front) !== frontNorm) continue;
        row.suspended = true;
        row.suspendedReason = "known";
        suspended += 1;
      }
      return { front: card.front, cards: suspended };
    },

    async setBuried(cardId, until) {
      const card = state.cards.get(cardId);
      if (card) card.buriedUntil = until;
    },

    async deleteNote(noteId) {
      state.deletedNotes.push(noteId);
    },

    async reportNote(input) {
      state.reports.push({ noteId: input.noteId, userId: input.userId });
    },

    async countDue() {
      return state.remainingDue;
    },

    async nextDue() {
      return state.nextDue;
    },

    async listLeeches({ cardIds, threshold }) {
      return cardIds
        .map((id) => state.cards.get(id))
        .filter((card): card is FakeCard => card !== undefined)
        .filter((card) => !card.suspended && card.state.lapses >= threshold)
        .slice(0, 1)
        .map((card) => ({ cardId: card.id, lapses: card.state.lapses, front: card.front }));
    },

    async newLimitFor() {
      return state.newLimit;
    },

    async saveStreak(_userId, update) {
      state.streakSaves.push({ streak: update.streak, lastDay: update.lastDay });
    },
  };

  return { port, state };
}

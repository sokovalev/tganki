import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { toCardState } from "../db/repos/cards.js";
import type { Repos } from "../db/repos/index.js";
import { userDecks } from "../db/schema.js";
import type { SessionPort } from "./sessionService.js";

/** Wires the session service to the real database. */
export function createSessionPort(db: Database, repos: Repos): SessionPort {
  return {
    queue: repos.cards,
    undo: repos.reviewLogs,

    findActiveSession: (userId) => repos.sessions.findActive(userId),
    findSession: (id) => repos.sessions.findById(id),
    createSession: (input) => repos.sessions.create(input),
    saveSession: (id, patch) => repos.sessions.save(id, patch),
    finishSession: (id, status) => repos.sessions.finish(id, status),

    async cardView(cardId) {
      const row = await repos.cards.findForReview(cardId);
      if (!row) return null;
      return {
        cardId: row.card.id,
        noteId: row.note.id,
        deckId: row.deck.id,
        deckTitle: row.deck.title,
        deckOwnerId: row.deck.ownerId,
        mode: row.card.mode,
        front: row.note.front,
        back: row.note.back,
        transcription: row.note.transcription,
        example: row.note.example,
        exampleTr: row.note.exampleTr,
      };
    },

    async cardState(cardId) {
      const card = await repos.cards.findById(cardId);
      return card ? toCardState(card) : null;
    },

    applyReview: (cardId, userId, result) => repos.cards.applyReview(cardId, userId, result),
    setSuspended: (cardId, suspended) => repos.cards.setSuspended(cardId, suspended),
    setBuried: (cardId, until) => repos.cards.setBuried(cardId, until),
    deleteNote: (noteId) => repos.notes.deleteById(noteId),
    reportNote: (input) => repos.noteReports.create(input),
    countDue: (input) => repos.cards.countDue(input),
    nextDue: (input) => repos.cards.nextDue(input),
    listLeeches: (input) => repos.cards.listLeeches(input),

    /** Sum of per-deck allowances, falling back to `users.daily_new_limit`. */
    async newLimitFor(user, deckId) {
      const conditions = [eq(userDecks.userId, user.id)];
      if (deckId !== null) conditions.push(eq(userDecks.deckId, deckId));
      const [row] = await db
        .select({
          total: sql<number>`coalesce(sum(coalesce(${userDecks.newPerDay}, ${user.dailyNewLimit})), 0)::int`,
        })
        .from(userDecks)
        .where(and(...conditions));
      return Number(row?.total ?? 0);
    },

    saveStreak: (userId, update) =>
      repos.users.saveStreak(userId, {
        ...update,
        extended: false,
        freezeUsed: false,
        reset: false,
      }),
  };
}

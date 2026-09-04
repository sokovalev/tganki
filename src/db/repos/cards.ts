import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import type { DueCard, NewCandidate, QueueRepo } from "../../core/queue.js";
import type { ApplyResult, CardState } from "../../core/scheduler.js";
import type { Database } from "../index.js";
import { type Card, type CardMode, cards, decks, notes, reviewLogs } from "../schema.js";

export interface ReviewCard {
  card: Card;
  note: {
    id: number;
    front: string;
    back: string;
    transcription: string | null;
    example: string | null;
    exampleTr: string | null;
    audioFileId: string | null;
    imageFileId: string | null;
  };
  deck: { id: number; title: string; langFrom: string; langTo: string };
}

export function toCardState(card: Card): CardState {
  return {
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    due: card.due,
    lastReview: card.lastReview,
    reps: card.reps,
    lapses: card.lapses,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
  };
}

export function createCardsRepo(db: Database) {
  const repo = {
    async findById(id: number): Promise<Card | null> {
      const [row] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
      return row ?? null;
    },

    /** Everything needed to render one card in the session message. */
    async findForReview(id: number): Promise<ReviewCard | null> {
      const [row] = await db
        .select({
          card: cards,
          note: {
            id: notes.id,
            front: notes.front,
            back: notes.back,
            transcription: notes.transcription,
            example: notes.example,
            exampleTr: notes.exampleTr,
            audioFileId: notes.audioFileId,
            imageFileId: notes.imageFileId,
          },
          deck: {
            id: decks.id,
            title: decks.title,
            langFrom: decks.langFrom,
            langTo: decks.langTo,
          },
        })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .innerJoin(decks, eq(decks.id, notes.deckId))
        .where(eq(cards.id, id))
        .limit(1);
      return row ?? null;
    },

    async listDueCards(input: {
      userId: number;
      deckId: number | null;
      now: Date;
      limit: number;
    }): Promise<DueCard[]> {
      const conditions = [
        eq(cards.userId, input.userId),
        eq(cards.suspended, false),
        // State.New cards are handed out by the new-card path, not as reviews.
        ne(cards.state, 0),
        lte(cards.due, input.now),
      ];
      const query = db
        .select({ cardId: cards.id, due: cards.due })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId));
      if (input.deckId !== null) conditions.push(eq(notes.deckId, input.deckId));
      return query
        .where(and(...conditions))
        .orderBy(asc(cards.due), asc(cards.id))
        .limit(input.limit);
    },

    async listNewCandidates(input: {
      userId: number;
      deckId: number | null;
      limit: number;
    }): Promise<NewCandidate[]> {
      const deckFilter = input.deckId === null ? sql`` : sql` and ud.deck_id = ${input.deckId}`;
      const rows = (await db.execute(sql`
        select n.id::int as note_id,
               n.deck_id::int as deck_id,
               m.mode::text as mode,
               n.position::int as position,
               c.id::int as card_id
        from user_decks ud
        cross join lateral unnest(ud.modes) as m(mode)
        join notes n on n.deck_id = ud.deck_id
        left join cards c
          on c.note_id = n.id and c.user_id = ud.user_id and c.mode = m.mode
        where ud.user_id = ${input.userId}
          and (c.id is null or (c.state = 0 and c.suspended = false))${deckFilter}
        order by ud.added_at, n.deck_id, n.position, n.id, m.mode
        limit ${input.limit}
      `)) as unknown as Array<{
        note_id: number;
        deck_id: number;
        mode: CardMode;
        position: number;
        card_id: number | null;
      }>;
      return rows.map((row) => ({
        noteId: row.note_id,
        deckId: row.deck_id,
        mode: row.mode,
        position: row.position,
        cardId: row.card_id,
      }));
    },

    async countNewIntroducedSince(input: { userId: number; since: Date }): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewLogs)
        .where(
          and(
            eq(reviewLogs.userId, input.userId),
            eq(reviewLogs.stateBefore, 0),
            gte(reviewLogs.reviewedAt, input.since),
          ),
        );
      return row?.count ?? 0;
    },

    async createCard(input: {
      userId: number;
      noteId: number;
      mode: CardMode;
      due: Date;
    }): Promise<number> {
      const [row] = await db
        .insert(cards)
        .values({
          userId: input.userId,
          noteId: input.noteId,
          mode: input.mode,
          due: input.due,
        })
        .onConflictDoUpdate({
          target: [cards.noteId, cards.userId, cards.mode],
          set: { due: input.due },
        })
        .returning({ id: cards.id });
      return row!.id;
    },

    /** Persists a rating: updates the card and appends its undo snapshot. */
    async applyReview(cardId: number, userId: number, result: ApplyResult): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(cards)
          .set({
            state: result.card.state,
            stability: result.card.stability,
            difficulty: result.card.difficulty,
            due: result.card.due,
            lastReview: result.card.lastReview,
            reps: result.card.reps,
            lapses: result.card.lapses,
            elapsedDays: result.card.elapsedDays,
            scheduledDays: result.card.scheduledDays,
            learningSteps: result.card.learningSteps,
          })
          .where(eq(cards.id, cardId));
        await tx.insert(reviewLogs).values({ cardId, userId, ...result.log });
      });
    },

    async setSuspended(cardId: number, suspended: boolean): Promise<void> {
      await db.update(cards).set({ suspended }).where(eq(cards.id, cardId));
    },
  };

  return repo satisfies QueueRepo;
}

export type CardsRepo = ReturnType<typeof createCardsRepo>;

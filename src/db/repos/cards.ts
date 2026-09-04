import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DueCard, NewCandidate, QueueRepo } from "../../core/queue.js";
import type { ApplyResult, CardState } from "../../core/scheduler.js";
import type { Database } from "../index.js";
import { type Card, type CardMode, cards, decks, notes, reviewLogs, userDecks } from "../schema.js";

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
  deck: {
    id: number;
    title: string;
    langFrom: string;
    langTo: string;
    ownerId: number | null;
  };
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

/** Cards that are ready to be reviewed right now. */
function dueConditions(input: { userId: number; deckId: number | null; now: Date }) {
  const conditions = [
    eq(cards.userId, input.userId),
    eq(cards.suspended, false),
    // State.New cards are handed out by the new-card path, not as reviews.
    ne(cards.state, 0),
    lte(cards.due, input.now),
    or(isNull(cards.buriedUntil), lte(cards.buriedUntil, input.now))!,
  ];
  if (input.deckId !== null) conditions.push(eq(notes.deckId, input.deckId));
  return conditions;
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
            ownerId: decks.ownerId,
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
      const query = db
        .select({ cardId: cards.id, due: cards.due })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        // Only decks the user is still subscribed to; unsubscribing keeps progress
        // but takes the cards out of the queues (SPEC §5.1).
        .innerJoin(
          userDecks,
          and(eq(userDecks.deckId, notes.deckId), eq(userDecks.userId, cards.userId)),
        );
      return query
        .where(and(...dueConditions(input)))
        .orderBy(asc(cards.due), asc(cards.id))
        .limit(input.limit);
    },

    /** Same predicate as `listDueCards`, without the cap — for menu/deck counters. */
    async countDue(input: { userId: number; deckId: number | null; now: Date }): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .innerJoin(
          userDecks,
          and(eq(userDecks.deckId, notes.deckId), eq(userDecks.userId, cards.userId)),
        )
        .where(and(...dueConditions(input)));
      return row?.count ?? 0;
    },

    /** Earliest upcoming card and how many share that learning day. */
    async nextDue(input: {
      userId: number;
      deckId: number | null;
      now: Date;
    }): Promise<{ at: Date; count: number } | null> {
      const conditions = [
        eq(cards.userId, input.userId),
        eq(cards.suspended, false),
        ne(cards.state, 0),
        gte(cards.due, input.now),
      ];
      if (input.deckId !== null) conditions.push(eq(notes.deckId, input.deckId));
      const [row] = await db
        .select({ due: cards.due })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .innerJoin(
          userDecks,
          and(eq(userDecks.deckId, notes.deckId), eq(userDecks.userId, cards.userId)),
        )
        .where(and(...conditions))
        .orderBy(asc(cards.due))
        .limit(1);
      if (!row) return null;
      const until = new Date(row.due.getTime() + 24 * 60 * 60 * 1000);
      const [counted] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .innerJoin(
          userDecks,
          and(eq(userDecks.deckId, notes.deckId), eq(userDecks.userId, cards.userId)),
        )
        .where(and(...conditions, lte(cards.due, until)));
      return { at: row.due, count: counted?.count ?? 1 };
    },

    async listNewCandidates(input: {
      userId: number;
      deckId: number | null;
      limit: number;
    }): Promise<NewCandidate[]> {
      const deckFilter = input.deckId === null ? sql`` : sql` and ud.deck_id = ${input.deckId}`;
      // `rn` numbers the candidates inside each deck, so ordering by it first
      // deals the new cards round-robin and one deck cannot eat the whole
      // daily allowance (SPEC §3.1).
      const rows = (await db.execute(sql`
        select note_id, deck_id, mode, position, card_id
        from (
          select n.id::int as note_id,
                 n.deck_id::int as deck_id,
                 m.mode::text as mode,
                 n.position::int as position,
                 c.id::int as card_id,
                 ud.added_at as added_at,
                 row_number() over (
                   partition by ud.deck_id order by n.position, n.id, m.mode
                 ) as rn
          from user_decks ud
          cross join lateral unnest(ud.modes) as m(mode)
          join notes n on n.deck_id = ud.deck_id
          left join cards c
            on c.note_id = n.id and c.user_id = ud.user_id and c.mode = m.mode
          where ud.user_id = ${input.userId}
            and (c.id is null or (c.state = 0 and c.suspended = false))
            and (c.id is null or c.buried_until is null or c.buried_until <= now())
            -- A reverse card only becomes available a day after the forward one
            -- was first shown, so both never land in the same session.
            and (
              m.mode <> 'recall'
              or not ('recognition' = any(ud.modes))
              or exists (
                select 1 from cards rc
                where rc.note_id = n.id and rc.user_id = ud.user_id
                  and rc.mode = 'recognition' and rc.last_review is not null
                  and rc.last_review <= now() - interval '1 day'
              )
            )${deckFilter}
        ) candidates
        order by rn, added_at, deck_id, position, note_id, mode
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

    /** Takes the card out of every queue until `until` ("отложить до завтра"). */
    async setBuried(cardId: number, until: Date | null): Promise<void> {
      await db.update(cards).set({ buriedUntil: until }).where(eq(cards.id, cardId));
    },

    /** Cards of this user that turned into leeches (SPEC §3.4). */
    async listLeeches(input: {
      userId: number;
      cardIds: number[];
      threshold: number;
    }): Promise<Array<{ cardId: number; lapses: number; front: string }>> {
      if (input.cardIds.length === 0) return [];
      return db
        .select({ cardId: cards.id, lapses: cards.lapses, front: notes.front })
        .from(cards)
        .innerJoin(notes, eq(notes.id, cards.noteId))
        .where(
          and(
            eq(cards.userId, input.userId),
            eq(cards.suspended, false),
            gte(cards.lapses, input.threshold),
            inArray(cards.id, input.cardIds),
          ),
        )
        .orderBy(asc(cards.id))
        .limit(1);
    },
  };

  return repo satisfies QueueRepo;
}

export type CardsRepo = ReturnType<typeof createCardsRepo>;

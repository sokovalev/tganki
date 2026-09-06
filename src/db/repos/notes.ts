import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { decks, knownWords, type NewNote, type Note, notes, userDecks } from "../schema.js";
import { frontNorm, normalizeFrontValue } from "../sql.js";

export interface DuplicateNote {
  noteId: number;
  deckId: number;
  deckTitle: string;
  /** null for builtin decks. */
  deckOwnerId: number | null;
  front: string;
  back: string;
  /** 1-based position inside the deck, as shown to the user. */
  position: number;
}

/**
 * What a word from a text turned out to be for this user (SPEC §4.3):
 * `known` — nothing to offer; `inDeck` — it waits in a deck they are
 * subscribed to and can be pulled into the next session as is. A word missing
 * from the classification map is fresh.
 */
export type FrontClass =
  | { kind: "known" }
  | { kind: "inDeck"; noteId: number; deckId: number; deckTitle: string };

const CHUNK = 500;

/** `excluded.<column>` — the value the failed INSERT tried to write. */
const excluded = (column: string) => sql.raw(`excluded."${column}"`);

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createNotesRepo(db: Database) {
  return {
    listByDeck(deckId: number): Promise<Note[]> {
      return db
        .select()
        .from(notes)
        .where(eq(notes.deckId, deckId))
        .orderBy(notes.position, notes.id);
    },

    async findById(id: number): Promise<Note | null> {
      const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
      return row ?? null;
    },

    /**
     * Idempotent bulk upsert keyed by (deck_id, front): note ids — and therefore
     * every user's card progress — survive a re-seed, while `position` follows
     * the new order. Columns the deck files do not carry (audio/image file ids)
     * are left untouched on purpose.
     */
    async upsertMany(values: NewNote[]): Promise<void> {
      for (const batch of chunked(values)) {
        await db
          .insert(notes)
          .values(batch)
          .onConflictDoUpdate({
            target: [notes.deckId, notes.front],
            set: {
              back: excluded("back"),
              transcription: excluded("transcription"),
              example: excluded("example"),
              exampleTr: excluded("example_tr"),
              tags: excluded("tags"),
              position: excluded("position"),
            },
          });
      }
    },

    async create(input: {
      deckId: number;
      front: string;
      back: string;
      transcription?: string | null;
      example?: string | null;
      exampleTr?: string | null;
      tags?: string[];
    }): Promise<Note> {
      const [row] = await db
        .insert(notes)
        .values({
          deckId: input.deckId,
          front: input.front,
          back: input.back,
          transcription: input.transcription ?? null,
          example: input.example ?? null,
          exampleTr: input.exampleTr ?? null,
          tags: input.tags ?? [],
          position: sql`(select coalesce(max(n.position), -1) + 1 from ${notes} n where n.deck_id = ${input.deckId})`,
        })
        .onConflictDoNothing({ target: [notes.deckId, notes.front] })
        .returning();
      if (row) return row;
      const [existing] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.deckId, input.deckId), eq(notes.front, input.front)))
        .limit(1);
      return existing!;
    },

    /** Bulk insert for `word - translation` pastes; returns how many rows were new. */
    async createMany(
      deckId: number,
      pairs: ReadonlyArray<{ front: string; back: string }>,
    ): Promise<number> {
      if (pairs.length === 0) return 0;
      const [start] = await db
        .select({ next: sql<number>`(coalesce(max(${notes.position}), -1) + 1)::int` })
        .from(notes)
        .where(eq(notes.deckId, deckId));
      const base = start?.next ?? 0;
      const inserted = await db
        .insert(notes)
        .values(
          pairs.map((pair, i) => ({
            deckId,
            front: pair.front,
            back: pair.back,
            position: base + i,
          })),
        )
        .onConflictDoNothing({ target: [notes.deckId, notes.front] })
        .returning({ id: notes.id });
      return inserted.length;
    },

    /**
     * Fills in what the note is missing (SPEC §4.1a "✨ Дополнить"): a column
     * that already holds text is never overwritten, so a user's own wording
     * always wins over a generated one.
     */
    async fillEmpty(
      id: number,
      values: { transcription?: string; example?: string; exampleTr?: string },
    ): Promise<Note | null> {
      const patch: Record<string, unknown> = {};
      if (values.transcription) {
        patch.transcription = sql`coalesce(nullif(${notes.transcription}, ''), ${values.transcription})`;
      }
      if (values.example) {
        patch.example = sql`coalesce(nullif(${notes.example}, ''), ${values.example})`;
        patch.exampleTr = sql`case when nullif(${notes.example}, '') is null then ${values.exampleTr ?? null} else ${notes.exampleTr} end`;
      }
      if (Object.keys(patch).length === 0) return this.findById(id);
      const [row] = await db.update(notes).set(patch).where(eq(notes.id, id)).returning();
      return row ?? null;
    },

    async deleteById(id: number): Promise<void> {
      await db.delete(notes).where(eq(notes.id, id));
    },

    /** Notes across every deck the user owns — the Free-plan note budget. */
    async countOwnedBy(ownerId: number): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .innerJoin(decks, eq(decks.id, notes.deckId))
        .where(eq(decks.ownerId, ownerId));
      return row?.count ?? 0;
    },

    /**
     * Looks for `front` among the decks the user owns or is subscribed to
     * (SPEC §4.1). A word can match in several decks; picking the one to show
     * is the caller's job (`pickDuplicate` prefers the user's own deck).
     */
    async findDuplicates(input: { userId: number; fronts: string[] }): Promise<DuplicateNote[]> {
      if (input.fronts.length === 0) return [];
      const lowered = input.fronts.map((front) => front.toLowerCase());
      return db
        .selectDistinctOn([notes.id], {
          noteId: notes.id,
          deckId: decks.id,
          deckTitle: decks.title,
          deckOwnerId: decks.ownerId,
          front: notes.front,
          back: notes.back,
          position: sql<number>`(${notes.position} + 1)::int`,
        })
        .from(notes)
        .innerJoin(decks, eq(decks.id, notes.deckId))
        .leftJoin(
          userDecks,
          and(eq(userDecks.deckId, decks.id), eq(userDecks.userId, input.userId)),
        )
        .where(
          and(
            inArray(sql`lower(${notes.front})`, lowered),
            or(eq(decks.ownerId, input.userId), eq(userDecks.userId, input.userId)),
          ),
        )
        .orderBy(asc(notes.id));
    },

    /**
     * Sorts the words of a text into the three buckets of §4.3, keyed by the
     * normalized front (§3.7). What is missing from the map is *fresh*: the
     * user has never seen it and it gets a generated card of its own.
     *
     * - `known` — a `known_words` row, a card of this user with `reps > 0` for
     *   a note with the same word (studied at least once; an untouched `new`
     *   card does not count), or a note in a deck the user **owns**, which is a
     *   real duplicate of their own word.
     * - `inDeck` — the word sits in a deck the user is subscribed to but does
     *   not own (a builtin deck), and they have not started it: the card is
     *   simply not reached yet, so it is offered as «взять в сессию», not
     *   dropped as knowledge.
     *
     * Two queries, both over the whole word list: `known_words`, and every note
     * of the learning language the user can reach at all.
     */
    async classifyFronts(input: {
      userId: number;
      langFrom: string;
      fronts: string[];
    }): Promise<Map<string, FrontClass>> {
      const classified = new Map<string, FrontClass>();
      const wanted = [...new Set(input.fronts.map(normalizeFrontValue))].filter(
        (front) => front !== "",
      );
      if (wanted.length === 0) return classified;
      const subscribed = sql`exists (select 1 from user_decks ud
                                      where ud.deck_id = ${decks.id} and ud.user_id = ${input.userId})`;
      const [known, reachable] = await Promise.all([
        db
          .select({ front: knownWords.frontNorm })
          .from(knownWords)
          .where(
            and(
              eq(knownWords.userId, input.userId),
              eq(knownWords.langFrom, input.langFrom),
              inArray(knownWords.frontNorm, wanted),
            ),
          ),
        db
          .select({
            front: frontNorm(sql`${notes.front}`),
            noteId: notes.id,
            deckId: decks.id,
            deckTitle: decks.title,
            owned: sql<boolean>`coalesce(${decks.ownerId} = ${input.userId}, false)`,
            subscribed: sql<boolean>`${subscribed}`,
            // Started = rated at least once. A `new` card the queue built and
            // the user never answered is not knowledge (SPEC §4.3).
            started: sql<boolean>`exists (select 1 from cards c
                                           where c.note_id = ${notes.id}
                                             and c.user_id = ${input.userId}
                                             and c.reps > 0)`,
          })
          .from(notes)
          .innerJoin(decks, eq(decks.id, notes.deckId))
          .where(
            and(
              eq(decks.langFrom, input.langFrom),
              inArray(frontNorm(sql`${notes.front}`), wanted),
              or(
                eq(decks.ownerId, input.userId),
                subscribed,
                sql`exists (select 1 from cards c
                             where c.note_id = ${notes.id} and c.user_id = ${input.userId})`,
              ),
            ),
          )
          .orderBy(asc(notes.id)),
      ]);

      for (const row of known) classified.set(String(row.front), { kind: "known" });
      for (const row of reachable) {
        const front = String(row.front);
        if (classified.get(front)?.kind === "known") continue;
        if (row.owned || row.started) {
          classified.set(front, { kind: "known" });
          continue;
        }
        // The first subscribed deck holding the word wins; notes are ordered by
        // id, so the same text always names the same deck.
        if (row.subscribed && !classified.has(front)) {
          classified.set(front, {
            kind: "inDeck",
            noteId: row.noteId,
            deckId: row.deckId,
            deckTitle: row.deckTitle,
          });
        }
      }
      return classified;
    },

    /** Removes notes of a deck whose front is no longer present in the source. */
    async deleteMissing(deckId: number, keepFronts: string[]): Promise<number> {
      if (keepFronts.length === 0) {
        const deleted = await db.delete(notes).where(eq(notes.deckId, deckId)).returning({
          id: notes.id,
        });
        return deleted.length;
      }
      const deleted = await db
        .delete(notes)
        .where(and(eq(notes.deckId, deckId), notInArray(notes.front, keepFronts)))
        .returning({ id: notes.id });
      return deleted.length;
    },
  };
}

export type NotesRepo = ReturnType<typeof createNotesRepo>;

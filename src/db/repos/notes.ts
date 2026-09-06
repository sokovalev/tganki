import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { decks, type NewNote, type Note, notes, userDecks } from "../schema.js";

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

import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { type NewNote, type Note, notes } from "../schema.js";

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

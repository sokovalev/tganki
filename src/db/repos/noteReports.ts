import { desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../index.js";
import { decks, noteReports, notes } from "../schema.js";

export interface OpenReport {
  id: number;
  noteId: number;
  front: string;
  back: string;
  deckTitle: string;
  reason: string | null;
  createdAt: Date;
}

export function createNoteReportsRepo(db: Database) {
  return {
    async create(input: { noteId: number; userId: number; reason?: string | null }): Promise<void> {
      await db.insert(noteReports).values({
        noteId: input.noteId,
        userId: input.userId,
        reason: input.reason ?? null,
      });
    },

    /** Newest unresolved reports, joined with the note they point at. */
    listOpen(limit = 10): Promise<OpenReport[]> {
      return db
        .select({
          id: noteReports.id,
          noteId: noteReports.noteId,
          front: notes.front,
          back: notes.back,
          deckTitle: decks.title,
          reason: noteReports.reason,
          createdAt: noteReports.createdAt,
        })
        .from(noteReports)
        .innerJoin(notes, eq(notes.id, noteReports.noteId))
        .innerJoin(decks, eq(decks.id, notes.deckId))
        .where(isNull(noteReports.resolvedAt))
        .orderBy(desc(noteReports.createdAt))
        .limit(limit);
    },
  };
}

export type NoteReportsRepo = ReturnType<typeof createNoteReportsRepo>;

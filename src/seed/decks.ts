import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createDb } from "../db/index.js";
import { createRepos, type Repos } from "../db/repos/index.js";
import type { NewNote } from "../db/schema.js";

const nullableString = z.string().trim().min(1).nullish();

export const deckNoteSchema = z.object({
  front: z.string().trim().min(1),
  back: z.string().trim().min(1),
  transcription: nullableString,
  example: nullableString,
  example_tr: nullableString,
  tags: z.array(z.string().trim().min(1)).default([]),
});

export const deckFileSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case"),
  title: z.string().trim().min(1),
  description: z.string().trim().nullish(),
  lang_from: z.string().trim().min(2),
  lang_to: z.string().trim().min(2),
  level: nullableString,
  notes: z.array(deckNoteSchema).min(1),
});

export type DeckFile = z.infer<typeof deckFileSchema>;
export type DeckNote = z.infer<typeof deckNoteSchema>;

export interface SeedResult {
  slug: string;
  deckId: number;
  notes: number;
  duplicates: number;
  removed: number;
}

/**
 * Maps deck-file notes to rows. Duplicate fronts are dropped (a note is
 * identified by its front inside a deck) and `position` follows file order.
 */
export function toNoteRows(deckId: number, notes: DeckNote[]): NewNote[] {
  const seen = new Set<string>();
  const rows: NewNote[] = [];
  for (const note of notes) {
    if (seen.has(note.front)) continue;
    seen.add(note.front);
    rows.push({
      deckId,
      front: note.front,
      back: note.back,
      transcription: note.transcription ?? null,
      example: note.example ?? null,
      exampleTr: note.example_tr ?? null,
      tags: note.tags,
      position: rows.length,
    });
  }
  return rows;
}

export function parseDeckFile(raw: unknown, source: string): DeckFile {
  const parsed = deckFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid deck file ${source}:\n${details}`);
  }
  return parsed.data;
}

/** Upserts one builtin deck and replaces its notes idempotently. */
export async function seedDeck(repos: Repos, file: DeckFile): Promise<SeedResult> {
  const deck = await repos.decks.upsertBuiltin({
    slug: file.slug,
    title: file.title,
    description: file.description ?? null,
    langFrom: file.lang_from,
    langTo: file.lang_to,
    level: file.level ?? null,
  });
  const rows = toNoteRows(deck.id, file.notes);
  await repos.notes.upsertMany(rows);
  const removed = await repos.notes.deleteMissing(
    deck.id,
    rows.map((row) => row.front),
  );
  return {
    slug: file.slug,
    deckId: deck.id,
    notes: rows.length,
    duplicates: file.notes.length - rows.length,
    removed,
  };
}

export async function seedDecksFromDir(repos: Repos, dir: string): Promise<SeedResult[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((name) => name.endsWith(".json")).sort();
  const results: SeedResult[] = [];
  for (const name of files) {
    const full = path.join(dir, name);
    const raw: unknown = JSON.parse(await readFile(full, "utf8"));
    results.push(await seedDeck(repos, parseDeckFile(raw, name)));
  }
  return results;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const dir = process.argv[2] ?? path.resolve("data/decks");
  const database = createDb(url, { max: 1 });
  try {
    const results = await seedDecksFromDir(createRepos(database.db), dir);
    if (results.length === 0) console.warn(`no deck files found in ${dir}`);
    for (const result of results) {
      console.log(
        `${result.slug}: ${result.notes} notes (deck #${result.deckId}` +
          `, ${result.removed} removed, ${result.duplicates} duplicates skipped)`,
      );
    }
  } finally {
    await database.close();
  }
}

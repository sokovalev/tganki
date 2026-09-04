import { and, eq } from "drizzle-orm";
import type { Database } from "../index.js";
import { type CardMode, type Deck, decks, type NewDeck, userDecks } from "../schema.js";

export function createDecksRepo(db: Database) {
  return {
    async findById(id: number): Promise<Deck | null> {
      const [row] = await db.select().from(decks).where(eq(decks.id, id)).limit(1);
      return row ?? null;
    },

    async findBySlug(slug: string): Promise<Deck | null> {
      const [row] = await db.select().from(decks).where(eq(decks.slug, slug)).limit(1);
      return row ?? null;
    },

    listBuiltin(): Promise<Deck[]> {
      return db.select().from(decks).where(eq(decks.kind, "builtin"));
    },

    listOwnedBy(ownerId: number): Promise<Deck[]> {
      return db.select().from(decks).where(eq(decks.ownerId, ownerId));
    },

    /** Creates or updates a builtin deck, keyed by its slug. */
    async upsertBuiltin(deck: Omit<NewDeck, "kind" | "ownerId">): Promise<Deck> {
      const [row] = await db
        .insert(decks)
        .values({ ...deck, kind: "builtin", ownerId: null, isPublic: true })
        .onConflictDoUpdate({
          target: decks.slug,
          set: {
            title: deck.title,
            description: deck.description ?? null,
            langFrom: deck.langFrom,
            langTo: deck.langTo,
            level: deck.level ?? null,
          },
        })
        .returning();
      return row!;
    },

    listSubscribed(userId: number) {
      return db
        .select({
          deck: decks,
          newPerDay: userDecks.newPerDay,
          modes: userDecks.modes,
          addedAt: userDecks.addedAt,
        })
        .from(userDecks)
        .innerJoin(decks, eq(decks.id, userDecks.deckId))
        .where(eq(userDecks.userId, userId));
    },

    async subscribe(
      userId: number,
      deckId: number,
      options: { newPerDay?: number | null; modes?: CardMode[] } = {},
    ): Promise<void> {
      await db
        .insert(userDecks)
        .values({
          userId,
          deckId,
          newPerDay: options.newPerDay ?? null,
          modes: options.modes ?? ["recognition"],
        })
        .onConflictDoUpdate({
          target: [userDecks.userId, userDecks.deckId],
          set: {
            newPerDay: options.newPerDay ?? null,
            ...(options.modes ? { modes: options.modes } : {}),
          },
        });
    },

    async unsubscribe(userId: number, deckId: number): Promise<void> {
      await db
        .delete(userDecks)
        .where(and(eq(userDecks.userId, userId), eq(userDecks.deckId, deckId)));
    },
  };
}

export type DecksRepo = ReturnType<typeof createDecksRepo>;

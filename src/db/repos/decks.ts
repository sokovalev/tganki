import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import {
  type CardMode,
  type Deck,
  type DeckKind,
  decks,
  type NewDeck,
  userDecks,
} from "../schema.js";
import { ts } from "../sql.js";

/** Stability (days) at which a card counts as "learned" on the stats screens. */
export const MATURE_STABILITY_DAYS = 21;

export interface DeckWithCounts {
  deck: Deck;
  newPerDay: number | null;
  modes: CardMode[];
  /** Notes in the deck. */
  total: number;
  /** Cards ready for review right now. */
  due: number;
  /** (note, mode) pairs the user has not started yet. */
  fresh: number;
  /** Cards with stability ≥ 21 days. */
  learned: number;
}

export interface CatalogDeck {
  deck: Deck;
  total: number;
  subscribed: boolean;
}

const PUBLIC_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

/** Short, URL-safe id for `t.me/<bot>?start=deck_<id>`. */
export function generatePublicId(length = 10, random = Math.random): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PUBLIC_ID_ALPHABET[Math.floor(random() * PUBLIC_ID_ALPHABET.length)];
  }
  return out;
}

interface DeckCountsRow {
  id: number;
  new_per_day: number | null;
  modes: CardMode[];
  total: number;
  due: number;
  fresh: number;
  learned: number;
}

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

    async findByPublicId(publicId: string): Promise<Deck | null> {
      const [row] = await db.select().from(decks).where(eq(decks.publicId, publicId)).limit(1);
      return row ?? null;
    },

    /** Resolves a `deck_<ref>` deep link: builtin decks share by slug, user decks by public id. */
    async findByRef(ref: string): Promise<Deck | null> {
      return (await this.findBySlug(ref)) ?? (await this.findByPublicId(ref));
    },

    listBuiltin(): Promise<Deck[]> {
      return db.select().from(decks).where(eq(decks.kind, "builtin")).orderBy(asc(decks.id));
    },

    /** Builtin decks for one learning language, with sizes and subscription flags. */
    async listCatalog(input: { userId: number; langFrom: string }): Promise<CatalogDeck[]> {
      // The correlated subqueries are written out by hand: drizzle renders column
      // references unqualified inside a select-list fragment, which would make
      // `notes.deck_id = decks.id` collapse into `deck_id = id` on `notes`.
      const rows = await db
        .select({
          deck: decks,
          total: sql<number>`(select count(*)::int from notes n where n.deck_id = decks.id)`,
          subscribed: sql<boolean>`exists (
            select 1 from user_decks ud
            where ud.deck_id = decks.id and ud.user_id = ${input.userId}
          )`,
        })
        .from(decks)
        .where(and(eq(decks.kind, "builtin"), eq(decks.langFrom, input.langFrom)))
        .orderBy(asc(decks.level), asc(decks.id));
      return rows.map((row) => ({
        deck: row.deck,
        total: Number(row.total),
        subscribed: Boolean(row.subscribed),
      }));
    },

    listOwnedBy(ownerId: number): Promise<Deck[]> {
      return db.select().from(decks).where(eq(decks.ownerId, ownerId)).orderBy(asc(decks.id));
    },

    async countOwnedBy(ownerId: number): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(decks)
        .where(eq(decks.ownerId, ownerId));
      return row?.count ?? 0;
    },

    /** The user's own deck for a learning language, oldest first ("Мои слова · EN"). */
    async findPersonalDeck(ownerId: number, langFrom: string): Promise<Deck | null> {
      const [row] = await db
        .select()
        .from(decks)
        .where(
          and(eq(decks.ownerId, ownerId), eq(decks.kind, "user"), eq(decks.langFrom, langFrom)),
        )
        .orderBy(asc(decks.id))
        .limit(1);
      return row ?? null;
    },

    async createUserDeck(input: {
      ownerId: number;
      title: string;
      langFrom: string;
      langTo: string;
      kind?: DeckKind;
    }): Promise<Deck> {
      const [row] = await db
        .insert(decks)
        .values({
          ownerId: input.ownerId,
          title: input.title,
          langFrom: input.langFrom,
          langTo: input.langTo,
          kind: input.kind ?? "user",
          publicId: generatePublicId(),
        })
        .returning();
      return row!;
    },

    async deleteDeck(id: number): Promise<void> {
      await db.delete(decks).where(eq(decks.id, id));
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
        .where(eq(userDecks.userId, userId))
        .orderBy(asc(userDecks.addedAt), asc(decks.id));
    },

    async findSubscription(
      userId: number,
      deckId: number,
    ): Promise<{ newPerDay: number | null; modes: CardMode[] } | null> {
      const [row] = await db
        .select({ newPerDay: userDecks.newPerDay, modes: userDecks.modes })
        .from(userDecks)
        .where(and(eq(userDecks.userId, userId), eq(userDecks.deckId, deckId)))
        .limit(1);
      return row ?? null;
    },

    /**
     * Every subscribed deck with the four counters the deck screens show.
     * One round trip: the counters are correlated subqueries, not N+1 calls.
     */
    async listSubscribedWithCounts(input: {
      userId: number;
      now: Date;
    }): Promise<DeckWithCounts[]> {
      const subscribed = await this.listSubscribed(input.userId);
      if (subscribed.length === 0) return [];
      const rows = (await db.execute(sql`
        select d.id::int as id,
               ud.new_per_day::int as new_per_day,
               ud.modes as modes,
               (select count(*) from notes n where n.deck_id = d.id)::int as total,
               (select count(*) from cards c
                  join notes n on n.id = c.note_id
                 where n.deck_id = d.id and c.user_id = ud.user_id
                   and c.suspended = false and c.state <> 0 and c.due <= ${ts(input.now)}
                   and (c.buried_until is null or c.buried_until <= ${ts(input.now)}))::int as due,
               (select count(*) from notes n
                  cross join lateral unnest(ud.modes) as m(mode)
                  left join cards c
                    on c.note_id = n.id and c.user_id = ud.user_id and c.mode = m.mode
                 where n.deck_id = d.id
                   and (c.id is null or (c.state = 0 and c.suspended = false)))::int as fresh,
               (select count(*) from cards c
                  join notes n on n.id = c.note_id
                 where n.deck_id = d.id and c.user_id = ud.user_id
                   and c.stability >= ${MATURE_STABILITY_DAYS})::int as learned
        from user_decks ud
        join decks d on d.id = ud.deck_id
        where ud.user_id = ${input.userId}
      `)) as unknown as DeckCountsRow[];
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      return subscribed.map((row) => {
        const counts = byId.get(row.deck.id);
        return {
          deck: row.deck,
          newPerDay: row.newPerDay,
          modes: row.modes,
          total: Number(counts?.total ?? 0),
          due: Number(counts?.due ?? 0),
          fresh: Number(counts?.fresh ?? 0),
          learned: Number(counts?.learned ?? 0),
        };
      });
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

    async updateSubscription(
      userId: number,
      deckId: number,
      patch: { newPerDay?: number | null; modes?: CardMode[] },
    ): Promise<void> {
      await db
        .update(userDecks)
        .set(patch)
        .where(and(eq(userDecks.userId, userId), eq(userDecks.deckId, deckId)));
    },

    async unsubscribe(userId: number, deckId: number): Promise<void> {
      await db
        .delete(userDecks)
        .where(and(eq(userDecks.userId, userId), eq(userDecks.deckId, deckId)));
    },

    /** Backfills a share id for a deck that predates public links. */
    async ensurePublicId(deckId: number): Promise<string> {
      const [row] = await db
        .update(decks)
        .set({ publicId: generatePublicId() })
        .where(and(eq(decks.id, deckId), isNull(decks.publicId)))
        .returning({ publicId: decks.publicId });
      if (row?.publicId) return row.publicId;
      const deck = await this.findById(deckId);
      return deck?.publicId ?? deck?.slug ?? String(deckId);
    },
  };
}

export type DecksRepo = ReturnType<typeof createDecksRepo>;

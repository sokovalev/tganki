import { desc, eq } from "drizzle-orm";
import type { Database } from "../index.js";
import { type Payment, payments, users } from "../schema.js";

export function createPaymentsRepo(db: Database) {
  return {
    /**
     * Stores one Stars charge. `payments_tg_charge_id_key` makes this the
     * idempotency point of the whole payment flow: a re-delivered
     * `successful_payment` returns null and grants nothing twice (SPEC §9.2).
     */
    async insert(input: {
      userId: number;
      tgChargeId: string;
      stars: number;
      product: string;
      subscriptionExpiresAt?: Date | null;
    }): Promise<Payment | null> {
      const [row] = await db
        .insert(payments)
        .values({
          userId: input.userId,
          tgChargeId: input.tgChargeId,
          stars: input.stars,
          product: input.product,
          subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
        })
        .onConflictDoNothing({ target: payments.tgChargeId })
        .returning();
      return row ?? null;
    },

    async findByChargeId(chargeId: string): Promise<Payment | null> {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.tgChargeId, chargeId))
        .limit(1);
      return row ?? null;
    },

    /** Newest charges first, with the payer's Telegram id — for `/admin payments`. */
    async listRecent(limit = 10, tgId?: number): Promise<(Payment & { tgId: number })[]> {
      const rows = await db
        .select({ payment: payments, tgId: users.tgId })
        .from(payments)
        .innerJoin(users, eq(users.id, payments.userId))
        .where(tgId === undefined ? undefined : eq(users.tgId, tgId))
        .orderBy(desc(payments.id))
        .limit(limit);
      return rows.map((row) => ({ ...row.payment, tgId: row.tgId }));
    },

    /** The user's most recent charge — the only one that can still hold up their plan. */
    async latestFor(userId: number): Promise<Payment | null> {
      const [row] = await db
        .select()
        .from(payments)
        .where(eq(payments.userId, userId))
        .orderBy(desc(payments.id))
        .limit(1);
      return row ?? null;
    },
  };
}

export type PaymentsRepo = ReturnType<typeof createPaymentsRepo>;

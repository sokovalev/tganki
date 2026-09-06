import type { EventName } from "../db/repos/events.js";
import type { Payment, User, UserPlan } from "../db/schema.js";
import { isPro } from "./limits.js";
import { findProduct, isProductId, type Product, type ProductId } from "./products.js";

/**
 * Telegram Stars, the payment half (SPEC §9.2). Everything here is pure
 * arithmetic over `users.plan` / `users.plan_until` plus a thin port, so the
 * grant rules can be tested without a bot and without a database.
 */

const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

/** Bot API caps the invoice payload at 128 bytes. */
export const PAYLOAD_MAX_BYTES = 128;

export interface PaymentPayload {
  product: ProductId;
  /** Internal `users.id`, not the Telegram id. */
  userId: number;
  /** Makes every invoice unique, so an old button cannot be replayed. */
  nonce: string;
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** `<product>:<userId>:<nonce>` — the only format `parsePayload` accepts. */
export function buildPayload(product: ProductId, userId: number, nonce = randomNonce()): string {
  return `${product}:${userId}:${nonce}`;
}

export function parsePayload(raw: string): PaymentPayload | null {
  if (raw.length === 0 || encoder.encode(raw).length > PAYLOAD_MAX_BYTES) return null;
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [product, rawUserId, nonce] = parts as [string, string, string];
  if (!isProductId(product)) return null;
  if (!/^\d+$/u.test(rawUserId)) return null;
  const userId = Number(rawUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!/^[a-z0-9]+$/u.test(nonce)) return null;
  return { product, userId, nonce };
}

export type PayloadCheck =
  | { ok: true; payload: PaymentPayload; product: Product }
  | { ok: false; reason: "malformed" | "unknown_product" | "wrong_user" };

/**
 * The `pre_checkout_query` gate: the payload has to parse, name a product we
 * still sell, and belong to the user who is paying. The amount is deliberately
 * *not* compared — a subscription renewal is charged at the price of the
 * original invoice, which may no longer be the configured one.
 */
export function checkPayload(
  raw: string,
  input: { products: readonly Product[]; userId: number },
): PayloadCheck {
  const payload = parsePayload(raw);
  if (!payload) return { ok: false, reason: "malformed" };
  const product = findProduct(input.products, payload.product);
  if (!product) return { ok: false, reason: "unknown_product" };
  if (payload.userId !== input.userId) return { ok: false, reason: "wrong_user" };
  return { ok: true, payload, product };
}

/** The `plan` / `plan_until` a payment (or a refund) leaves behind. */
export interface Grant {
  plan: UserPlan;
  planUntil: Date | null;
}

/**
 * What a successful payment grants (SPEC §9.2):
 * - lifetime is absolute — it is never shortened and never extended;
 * - a one-off adds its days to `max(now, plan_until)`, so buying early never
 *   burns the days already paid for;
 * - a subscription uses Telegram's `subscription_expiration_date` when the
 *   payment carries one, but never moves an existing longer plan backwards.
 *   Renewals arrive as ordinary payments and take exactly the same path.
 */
export function grantFor(input: {
  product: Product;
  user: Pick<User, "plan" | "planUntil">;
  now: Date;
  /** `successful_payment.subscription_expiration_date`, already a Date. */
  expiresAt?: Date | null;
}): Grant {
  const { product, user, now } = input;
  if (user.plan === "lifetime") return { plan: "lifetime", planUntil: null };
  if (product.days === null) return { plan: "lifetime", planUntil: null };
  const active = isPro(user, now) ? user.planUntil : null;
  if (input.expiresAt) {
    const until = active && active.getTime() > input.expiresAt.getTime() ? active : input.expiresAt;
    return { plan: "pro", planUntil: until };
  }
  const base = active ?? now;
  return { plan: "pro", planUntil: new Date(base.getTime() + product.days * DAY_MS) };
}

/**
 * What a refund leaves behind (SPEC §9.2, `/admin refund`). The grant is
 * reversed by the length it added: a dated product gives back its days, a
 * lifetime purchase gives back the plan itself. A plan that ends up in the
 * past collapses to `free` — the hourly sweep would do it anyway.
 */
export function revokeFor(input: {
  product: Product;
  user: Pick<User, "plan" | "planUntil">;
  now: Date;
}): Grant {
  const { product, user, now } = input;
  if (product.days === null || user.plan === "lifetime") return { plan: "free", planUntil: null };
  if (user.planUntil === null) return { plan: "free", planUntil: null };
  const until = new Date(user.planUntil.getTime() - product.days * DAY_MS);
  if (until.getTime() <= now.getTime()) return { plan: "free", planUntil: null };
  return { plan: "pro", planUntil: until };
}

export interface PaymentInsert {
  userId: number;
  tgChargeId: string;
  stars: number;
  product: string;
  subscriptionExpiresAt: Date | null;
}

export interface PaymentPort {
  /** Stores the charge; null when that charge id is already there (idempotent). */
  insert(input: PaymentInsert): Promise<Payment | null>;
  findByChargeId(chargeId: string): Promise<Payment | null>;
  /** The user's most recent payment, whatever it bought. */
  latestFor(userId: number): Promise<Payment | null>;
  findUser(userId: number): Promise<User | null>;
  updatePlan(userId: number, grant: Grant): Promise<User>;
  /** `plan = 'pro'` rows whose `plan_until` has passed. */
  listExpired(now: Date, limit: number): Promise<User[]>;
  /** Fire and forget, like everywhere else analytics is written (SPEC §12). */
  record(userId: number | null, name: EventName, props: Record<string, unknown>): void;
}

export interface ApplyInput {
  user: User;
  /** `successful_payment.invoice_payload`. */
  payload: string;
  chargeId: string;
  stars: number;
  now: Date;
  recurring?: boolean;
  expiresAt?: Date | null;
}

export type ApplyResult =
  | { kind: "applied"; product: Product; grant: Grant; user: User }
  /** Telegram re-delivered a charge we have already granted. */
  | { kind: "duplicate"; product: Product | null }
  /** Paid for something this build does not sell — hand it to /paysupport. */
  | { kind: "unknown" };

export interface RefundLookup {
  payment: Payment;
  user: User;
  /** null when the row names a product this build no longer sells. */
  product: Product | null;
}

/** How many expired plans one hourly sweep is willing to touch. */
export const EXPIRY_BATCH = 500;

export function createPaymentService(port: PaymentPort, options: { products: readonly Product[] }) {
  const { products } = options;

  return {
    products,

    /** The `pre_checkout_query` decision (see `checkPayload`). */
    check(raw: string, userId: number): PayloadCheck {
      return checkPayload(raw, { products, userId });
    },

    /**
     * `successful_payment`: store the charge, then move the plan. The unique
     * index on `payments.tg_charge_id` is what makes a re-delivered update a
     * no-op — the grant only runs for a charge we had never seen.
     */
    async apply(input: ApplyInput): Promise<ApplyResult> {
      const payload = parsePayload(input.payload);
      const product = payload ? findProduct(products, payload.product) : null;
      if (!product) {
        port.record(input.user.id, "payment", {
          product: payload?.product ?? "unknown",
          stars: input.stars,
          recurring: input.recurring ?? false,
          unknown: true,
        });
        return { kind: "unknown" };
      }
      const stored = await port.insert({
        userId: input.user.id,
        tgChargeId: input.chargeId,
        stars: input.stars,
        product: product.id,
        subscriptionExpiresAt: input.expiresAt ?? null,
      });
      if (!stored) return { kind: "duplicate", product };

      const grant = grantFor({
        product,
        user: input.user,
        now: input.now,
        expiresAt: input.expiresAt ?? null,
      });
      const user = await port.updatePlan(input.user.id, grant);
      port.record(input.user.id, "payment", {
        product: product.id,
        stars: input.stars,
        recurring: input.recurring ?? false,
      });
      return { kind: "applied", product, grant, user };
    },

    /** `/admin refund <charge_id>`: who paid what, before we call Telegram. */
    async lookup(chargeId: string): Promise<RefundLookup | null> {
      const payment = await port.findByChargeId(chargeId);
      if (!payment) return null;
      const user = await port.findUser(payment.userId);
      if (!user) return null;
      return { payment, user, product: findProduct(products, payment.product) };
    },

    /**
     * The database half of a refund, run after Telegram accepted it. Only the
     * user's latest payment can still be holding up their plan; refunding an
     * older charge leaves the plan alone (a later purchase already paid for it).
     */
    async revoke(input: { payment: Payment; user: User; now: Date }): Promise<Grant | null> {
      const product = findProduct(products, input.payment.product);
      const latest = await port.latestFor(input.user.id);
      port.record(input.user.id, "refund", {
        product: input.payment.product,
        stars: input.payment.stars,
        chargeId: input.payment.tgChargeId,
      });
      if (!product || latest?.id !== input.payment.id) return null;
      const grant = revokeFor({ product, user: input.user, now: input.now });
      await port.updatePlan(input.user.id, grant);
      return grant;
    },

    /**
     * The hourly step (SPEC §9.2): a subscription cancelled on Telegram's side
     * simply stops renewing, so an expired `plan_until` is all we ever see.
     * `lifetime` has no `plan_until` and is never touched.
     */
    async expire(now: Date, limit = EXPIRY_BATCH): Promise<number> {
      const expired = await port.listExpired(now, limit);
      for (const user of expired) {
        await port.updatePlan(user.id, { plan: "free", planUntil: null });
        port.record(user.id, "pro_expired", {
          until: user.planUntil?.toISOString() ?? null,
        });
      }
      return expired.length;
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;

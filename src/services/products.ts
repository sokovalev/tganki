import type { Config } from "../config.js";

/**
 * What `/pro` sells (SPEC §9.2). Everything is priced in Telegram Stars: by
 * Telegram's rules digital goods inside a bot can be sold for nothing else.
 */

/** Telegram accepts exactly one subscription period today: 30 days. */
export const SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;
export const SUBSCRIPTION_DAYS = 30;
export const YEAR_DAYS = 365;
/** The admin-only product exists to run one real payment end to end. */
export const TEST_DAYS = 1;
export const TEST_STARS = 1;

export const PRODUCT_IDS = ["pro_month", "pro_year", "pro_lifetime", "pro_test"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export function isProductId(value: string): value is ProductId {
  return (PRODUCT_IDS as readonly string[]).includes(value);
}

export interface Product {
  id: ProductId;
  /** Suffix of the `pro-item-*` / `btn-buy-*` message ids. */
  key: "month" | "year" | "lifetime" | "test";
  /** Price in Stars; a Stars invoice carries exactly one price component. */
  stars: number;
  /** What the purchase makes the user. */
  plan: "pro" | "lifetime";
  /** Days added to `plan_until`; null = forever. */
  days: number | null;
  /**
   * Seconds between renewals. Set = the invoice is a Stars subscription and
   * has to be created with `createInvoiceLink`; `sendInvoice` has no such
   * parameter in Bot API 9.x (checked against the installed typings).
   */
  subscriptionPeriod?: number;
  /** Offered to `ADMIN_TG_IDS` only — a live test that can be refunded. */
  adminOnly?: boolean;
}

export type PriceConfig = Pick<Config, "PRO_PRICE_MONTH" | "PRO_PRICE_YEAR" | "PRO_PRICE_LIFETIME">;

/** The catalog, in the order the `/pro` screen lists it. */
export function createProducts(config: PriceConfig): readonly Product[] {
  return [
    {
      id: "pro_month",
      key: "month",
      stars: config.PRO_PRICE_MONTH,
      plan: "pro",
      days: SUBSCRIPTION_DAYS,
      subscriptionPeriod: SUBSCRIPTION_PERIOD_SECONDS,
    },
    {
      id: "pro_year",
      key: "year",
      stars: config.PRO_PRICE_YEAR,
      plan: "pro",
      days: YEAR_DAYS,
    },
    {
      id: "pro_lifetime",
      key: "lifetime",
      stars: config.PRO_PRICE_LIFETIME,
      plan: "lifetime",
      days: null,
    },
    {
      id: "pro_test",
      key: "test",
      stars: TEST_STARS,
      plan: "pro",
      days: TEST_DAYS,
      adminOnly: true,
    },
  ];
}

export function findProduct(products: readonly Product[], id: string): Product | null {
  return products.find((product) => product.id === id) ?? null;
}

/** What a given user may buy: the test product is for admins only. */
export function offeredProducts(
  products: readonly Product[],
  options: { admin: boolean },
): readonly Product[] {
  return products.filter((product) => options.admin || !product.adminOnly);
}

import type { InlineKeyboardButton } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  INVOICE_DESCRIPTION_MAX,
  INVOICE_TITLE_MAX,
  productButtonKey,
  productDescriptionKey,
  productTitleKey,
  renderPro,
} from "../src/bot/pro.js";
import type { Payment, User } from "../src/db/schema.js";
import { createI18n, SUPPORTED_LOCALES, translator } from "../src/i18n/index.js";
import {
  buildPayload,
  checkPayload,
  createPaymentService,
  type Grant,
  grantFor,
  type PaymentPort,
  parsePayload,
  revokeFor,
} from "../src/services/paymentService.js";
import {
  createProducts,
  findProduct,
  offeredProducts,
  SUBSCRIPTION_PERIOD_SECONDS,
} from "../src/services/products.js";
import { createFakeBot } from "./helpers/fakeBot.js";
import { makeUser } from "./helpers/fakeSession.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const DAY = 86_400_000;

const PRICES = { PRO_PRICE_MONTH: 199, PRO_PRICE_YEAR: 1499, PRO_PRICE_LIFETIME: 2999 };
const products = createProducts(PRICES);
const month = findProduct(products, "pro_month")!;
const year = findProduct(products, "pro_year")!;
const lifetime = findProduct(products, "pro_lifetime")!;
const test1 = findProduct(products, "pro_test")!;

const i18n = createI18n();
const ru = translator(i18n, "ru");
const en = translator(i18n, "en");

describe("the catalog", () => {
  it("prices itself from the config and keeps the one period Telegram allows", () => {
    expect(month.stars).toBe(199);
    expect(year.stars).toBe(1499);
    expect(lifetime.stars).toBe(2999);
    expect(month.subscriptionPeriod).toBe(SUBSCRIPTION_PERIOD_SECONDS);
    expect(SUBSCRIPTION_PERIOD_SECONDS).toBe(2_592_000);
    // Only the subscription renews; the others are one-off grants.
    expect(year.subscriptionPeriod).toBeUndefined();
    expect(lifetime.days).toBeNull();
  });

  it("offers the 1-Star live test to admins only", () => {
    expect(offeredProducts(products, { admin: false }).map((p) => p.id)).toEqual([
      "pro_month",
      "pro_year",
      "pro_lifetime",
    ]);
    expect(offeredProducts(products, { admin: true })).toHaveLength(4);
    expect(test1.stars).toBe(1);
    expect(test1.days).toBe(1);
  });

  it("has an invoice title, description and button in every locale, within Telegram's caps", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = translator(i18n, locale);
      for (const product of products) {
        const title = t(productTitleKey(product));
        const description = t(productDescriptionKey(product));
        const button = t(productButtonKey(product), { stars: product.stars });
        for (const value of [title, description, button]) {
          expect(value, `${locale}: ${product.id}`).not.toContain("{");
        }
        expect(title.length).toBeLessThanOrEqual(INVOICE_TITLE_MAX);
        expect(description.length).toBeLessThanOrEqual(INVOICE_DESCRIPTION_MAX);
        // Fluent groups thousands per locale ("1 499", "1,499"): compare digits.
        expect(button.replace(/\D/gu, "")).toContain(String(product.stars));
      }
    }
  });
});

describe("invoice payload", () => {
  it("round-trips product, user and nonce", () => {
    expect(buildPayload("pro_month", 42, "abc123")).toBe("pro_month:42:abc123");
    expect(parsePayload("pro_month:42:abc123")).toEqual({
      product: "pro_month",
      userId: 42,
      nonce: "abc123",
    });
    const generated = buildPayload("pro_year", 7);
    expect(parsePayload(generated)).toMatchObject({ product: "pro_year", userId: 7 });
    expect(generated.length).toBeLessThanOrEqual(128);
  });

  it("rejects anything that is not exactly our format", () => {
    for (const raw of [
      "",
      "junk",
      "pro_gold:1:abc",
      "pro_month:abc:x",
      "pro_month:-1:x",
      "pro_month:1",
      "pro_month:1:x:y",
      "pro_month:1:ПРИВЕТ",
      `pro_month:1:${"a".repeat(200)}`,
    ]) {
      expect(parsePayload(raw), raw).toBeNull();
    }
  });

  it("is the whole pre-checkout decision", () => {
    const ok = checkPayload(buildPayload("pro_month", 5, "n1"), { products, userId: 5 });
    expect(ok).toMatchObject({ ok: true, product: { id: "pro_month" } });
    expect(checkPayload("nonsense", { products, userId: 5 })).toEqual({
      ok: false,
      reason: "malformed",
    });
    // Someone else's invoice must never top up this account.
    expect(checkPayload(buildPayload("pro_month", 6, "n1"), { products, userId: 5 })).toEqual({
      ok: false,
      reason: "wrong_user",
    });
    expect(
      checkPayload(buildPayload("pro_month", 5, "n1"), { products: [year], userId: 5 }),
    ).toEqual({ ok: false, reason: "unknown_product" });
  });
});

describe("what a payment grants", () => {
  const free = makeUser();

  it("starts a month and a year from now", () => {
    expect(grantFor({ product: month, user: free, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(grantFor({ product: year, user: free, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(NOW.getTime() + 365 * DAY),
    });
    expect(grantFor({ product: test1, user: free, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(NOW.getTime() + DAY),
    });
  });

  it("extends an active plan instead of restarting it", () => {
    const until = new Date(NOW.getTime() + 5 * DAY);
    const active = makeUser({ plan: "pro", planUntil: until });
    expect(grantFor({ product: year, user: active, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(until.getTime() + 365 * DAY),
    });
  });

  it("restarts from now when the old plan has already lapsed", () => {
    const lapsed = makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() - DAY) });
    expect(grantFor({ product: month, user: lapsed, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(NOW.getTime() + 30 * DAY),
    });
  });

  it("takes Telegram's subscription expiry when the payment carries one", () => {
    const expiresAt = new Date(NOW.getTime() + 31 * DAY);
    expect(grantFor({ product: month, user: free, now: NOW, expiresAt })).toEqual({
      plan: "pro",
      planUntil: expiresAt,
    });
    // A renewal is an ordinary payment and takes exactly the same path.
    const renewing = makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + DAY) });
    expect(grantFor({ product: month, user: renewing, now: NOW, expiresAt })).toEqual({
      plan: "pro",
      planUntil: expiresAt,
    });
  });

  it("never moves a longer plan backwards", () => {
    const longer = makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + 300 * DAY) });
    const expiresAt = new Date(NOW.getTime() + 30 * DAY);
    expect(grantFor({ product: month, user: longer, now: NOW, expiresAt }).planUntil).toEqual(
      longer.planUntil,
    );
  });

  it("makes lifetime absolute in both directions", () => {
    expect(grantFor({ product: lifetime, user: free, now: NOW })).toEqual({
      plan: "lifetime",
      planUntil: null,
    });
    const forever = makeUser({ plan: "lifetime", planUntil: null });
    expect(grantFor({ product: month, user: forever, now: NOW })).toEqual({
      plan: "lifetime",
      planUntil: null,
    });
  });
});

describe("what a refund takes back", () => {
  it("gives back exactly the days the product added", () => {
    const user = makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + 370 * DAY) });
    expect(revokeFor({ product: year, user, now: NOW })).toEqual({
      plan: "pro",
      planUntil: new Date(NOW.getTime() + 5 * DAY),
    });
  });

  it("drops to free when nothing paid-for is left", () => {
    const user = makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + 10 * DAY) });
    expect(revokeFor({ product: year, user, now: NOW })).toEqual({ plan: "free", planUntil: null });
    const forever = makeUser({ plan: "lifetime", planUntil: null });
    expect(revokeFor({ product: lifetime, user: forever, now: NOW })).toEqual({
      plan: "free",
      planUntil: null,
    });
  });
});

/** The payment service on an in-memory charge table and a single user row. */
function fakePayments(initial: User = makeUser()) {
  let user = initial;
  const charges: Payment[] = [];
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  const plans: Grant[] = [];
  const port: PaymentPort = {
    async insert(input) {
      if (charges.some((row) => row.tgChargeId === input.tgChargeId)) return null;
      const row: Payment = {
        id: charges.length + 1,
        userId: input.userId,
        tgChargeId: input.tgChargeId,
        stars: input.stars,
        product: input.product,
        subscriptionExpiresAt: input.subscriptionExpiresAt,
        createdAt: NOW,
      };
      charges.push(row);
      return row;
    },
    async findByChargeId(chargeId) {
      return charges.find((row) => row.tgChargeId === chargeId) ?? null;
    },
    async latestFor(userId) {
      return [...charges].reverse().find((row) => row.userId === userId) ?? null;
    },
    async findUser(id) {
      return user.id === id ? user : null;
    },
    async updatePlan(_id, grant) {
      plans.push(grant);
      user = { ...user, ...grant };
      return user;
    },
    async listExpired(now, limit) {
      const expired =
        user.plan === "pro" && user.planUntil !== null && user.planUntil.getTime() < now.getTime();
      return expired ? [user].slice(0, limit) : [];
    },
    record(_userId, name, props) {
      events.push({ name, props });
    },
  };
  return {
    service: createPaymentService(port, { products }),
    charges,
    events,
    plans,
    user: () => user,
    setUser: (patch: Partial<User>) => {
      user = { ...user, ...patch };
    },
  };
}

describe("applying a successful payment", () => {
  it("stores the charge, moves the plan and records the event", async () => {
    const fake = fakePayments();
    const result = await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_year", 1, "n1"),
      chargeId: "charge_a",
      stars: 1499,
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "applied", product: { id: "pro_year" } });
    expect(fake.charges).toHaveLength(1);
    expect(fake.charges[0]).toMatchObject({ tgChargeId: "charge_a", stars: 1499 });
    expect(fake.user().plan).toBe("pro");
    expect(fake.user().planUntil).toEqual(new Date(NOW.getTime() + 365 * DAY));
    expect(fake.events).toEqual([
      { name: "payment", props: { product: "pro_year", stars: 1499, recurring: false } },
    ]);
  });

  it("ignores a charge id it has already granted", async () => {
    const fake = fakePayments();
    const input = {
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_b",
      stars: 199,
      now: NOW,
    };
    await fake.service.apply({ ...input, user: fake.user() });
    const granted = fake.user().planUntil;
    const again = await fake.service.apply({ ...input, user: fake.user() });
    expect(again).toMatchObject({ kind: "duplicate" });
    expect(fake.charges).toHaveLength(1);
    expect(fake.plans).toHaveLength(1);
    expect(fake.user().planUntil).toEqual(granted);
  });

  it("extends the same plan on a renewal", async () => {
    const fake = fakePayments();
    await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_1",
      stars: 199,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    const renewalAt = new Date(NOW.getTime() + 30 * DAY);
    const nextExpiry = new Date(NOW.getTime() + 60 * DAY);
    await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_2",
      stars: 199,
      now: renewalAt,
      recurring: true,
      expiresAt: nextExpiry,
    });
    expect(fake.user().planUntil).toEqual(nextExpiry);
    expect(fake.events.at(-1)).toEqual({
      name: "payment",
      props: { product: "pro_month", stars: 199, recurring: true },
    });
  });

  it("does not touch the plan when the payload names an unknown product", async () => {
    const fake = fakePayments();
    const result = await fake.service.apply({
      user: fake.user(),
      payload: "deck_a1:1:n1",
      chargeId: "charge_c",
      stars: 99,
      now: NOW,
    });
    expect(result).toEqual({ kind: "unknown" });
    expect(fake.charges).toHaveLength(0);
    expect(fake.user().plan).toBe("free");
  });
});

describe("the hourly expiry sweep", () => {
  it("downgrades a lapsed Pro plan once and records it", async () => {
    const fake = fakePayments(makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() - DAY) }));
    expect(await fake.service.expire(NOW)).toBe(1);
    expect(fake.user()).toMatchObject({ plan: "free", planUntil: null });
    expect(fake.events[0]?.name).toBe("pro_expired");
    // Nothing left to sweep on the next hour.
    expect(await fake.service.expire(NOW)).toBe(0);
  });

  it("leaves a live plan and a lifetime plan alone", async () => {
    const live = fakePayments(makeUser({ plan: "pro", planUntil: new Date(NOW.getTime() + DAY) }));
    expect(await live.service.expire(NOW)).toBe(0);
    const forever = fakePayments(makeUser({ plan: "lifetime", planUntil: null }));
    expect(await forever.service.expire(NOW)).toBe(0);
    expect(forever.user().plan).toBe("lifetime");
  });
});

describe("revoking a refunded charge", () => {
  it("shortens the plan by what the refunded product had added", async () => {
    const fake = fakePayments();
    await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_year", 1, "n1"),
      chargeId: "charge_a",
      stars: 1499,
      now: NOW,
    });
    const found = await fake.service.lookup("charge_a");
    expect(found).toMatchObject({ product: { id: "pro_year" } });
    const grant = await fake.service.revoke({
      payment: found!.payment,
      user: fake.user(),
      now: NOW,
    });
    expect(grant).toEqual({ plan: "free", planUntil: null });
    expect(fake.user()).toMatchObject({ plan: "free", planUntil: null });
    expect(fake.events.at(-1)?.name).toBe("refund");
  });

  it("leaves the plan alone when a later purchase is holding it up", async () => {
    const fake = fakePayments();
    await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_a",
      stars: 199,
      now: NOW,
    });
    await fake.service.apply({
      user: fake.user(),
      payload: buildPayload("pro_lifetime", 1, "n2"),
      chargeId: "charge_b",
      stars: 2999,
      now: NOW,
    });
    const old = await fake.service.lookup("charge_a");
    expect(await fake.service.revoke({ payment: old!.payment, user: fake.user(), now: NOW })).toBe(
      null,
    );
    expect(fake.user().plan).toBe("lifetime");
  });

  it("knows nothing about a charge id it never stored", async () => {
    const fake = fakePayments();
    expect(await fake.service.lookup("charge_missing")).toBeNull();
  });
});

describe("the /pro screen", () => {
  const screen = (options: { proEnabled: boolean; admin: boolean; user?: User; t?: typeof ru }) =>
    renderPro(options.t ?? ru, {
      user: options.user ?? makeUser(),
      now: NOW,
      products,
      proEnabled: options.proEnabled,
      admin: options.admin,
    });

  const buttons = (keyboard: { inline_keyboard: InlineKeyboardButton[][] } | undefined) =>
    (keyboard?.inline_keyboard ?? [])
      .flat()
      .map((button) => (button as { callback_data?: string }).callback_data ?? "");

  it("stays «скоро» for a regular user while PRO_ENABLED is off", () => {
    const rendered = screen({ proEnabled: false, admin: false });
    expect(rendered.text).toContain("Pro скоро появится");
    expect(buttons(rendered.keyboard)).toEqual(["m"]);
  });

  it("shows an admin the products anyway, so a live payment can be tested", () => {
    const rendered = screen({ proEnabled: false, admin: true });
    expect(buttons(rendered.keyboard)).toEqual([
      "pro:buy:pro_month",
      "pro:buy:pro_year",
      "pro:buy:pro_lifetime",
      "pro:buy:pro_test",
      "m",
    ]);
    expect(rendered.text).toContain("PRO_ENABLED=false");
  });

  it("sells the three real products once the gate is on", () => {
    const rendered = screen({ proEnabled: true, admin: false });
    expect(buttons(rendered.keyboard)).toEqual([
      "pro:buy:pro_month",
      "pro:buy:pro_year",
      "pro:buy:pro_lifetime",
      "m",
    ]);
    expect(rendered.keyboard?.inline_keyboard.flat()[0]?.text).toContain("199");
    expect(rendered.text).toContain("Что даёт Pro");
    expect(rendered.text).toContain("Сейчас у тебя: Free.");
  });

  it("names the plan and its expiry, in the user's timezone", () => {
    const pro = makeUser({
      plan: "pro",
      planUntil: new Date("2026-02-09T22:30:00.000Z"),
      tz: "Europe/Moscow",
    });
    expect(screen({ proEnabled: true, admin: false, user: pro }).text).toContain(
      "Pro до 2026-02-10",
    );
    const forever = makeUser({ plan: "lifetime", planUntil: null });
    const rendered = screen({ proEnabled: true, admin: false, user: forever });
    expect(rendered.text).toContain("Pro навсегда");
    // Nothing left to sell them.
    expect(buttons(rendered.keyboard)).toEqual(["m"]);
  });

  it("renders in English too", () => {
    const rendered = screen({ proEnabled: true, admin: false, t: en });
    expect(rendered.text).toContain("What Pro gives you");
    expect(rendered.text).not.toContain("{");
  });
});

describe("the payment flow through the bot", () => {
  const proBot = (options: { proEnabled?: boolean; admin?: boolean; user?: Partial<User> } = {}) =>
    createFakeBot({
      card: null,
      proEnabled: options.proEnabled ?? true,
      ...(options.admin ? { adminTgIds: [555] } : {}),
      user: { onboardingStep: null, ...options.user },
    });

  it("sends a plain invoice for a one-off product", async () => {
    const bot = proBot();
    await bot.text("/pro");
    await bot.tap("pro:buy:pro_year");
    const invoice = bot.calls.find((call) => call.method === "sendInvoice");
    expect(invoice?.payload).toMatchObject({
      currency: "XTR",
      provider_token: "",
      prices: [{ label: "tganki Pro — год", amount: 1499 }],
    });
    expect(parsePayload(String(invoice?.payload.payload))).toMatchObject({
      product: "pro_year",
      userId: 1,
    });
  });

  it("uses createInvoiceLink for the subscription, because sendInvoice has no period", async () => {
    const bot = proBot();
    await bot.tap("pro:buy:pro_month");
    expect(bot.calls.some((call) => call.method === "sendInvoice")).toBe(false);
    const link = bot.calls.find((call) => call.method === "createInvoiceLink");
    expect(link?.payload).toMatchObject({
      currency: "XTR",
      subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
    });
    const markup = bot.markups().at(-1) as { inline_keyboard: Array<Array<{ url?: string }>> };
    expect(markup.inline_keyboard.flat()[0]?.url).toBe("https://t.me/$invoice");
  });

  it("refuses to sell the admin test product to anyone else", async () => {
    const bot = proBot();
    await bot.tap("pro:buy:pro_test");
    expect(bot.calls.some((call) => call.method === "sendInvoice")).toBe(false);
    expect(bot.lastText()).toContain("Pro");
    const admin = proBot({ admin: true });
    await admin.tap("pro:buy:pro_test");
    const sold = admin.calls.find((call) => call.method === "sendInvoice");
    expect(sold?.payload.prices).toMatchObject([{ amount: 1 }]);
  });

  it("sells nothing to a regular user while PRO_ENABLED is off", async () => {
    const bot = proBot({ proEnabled: false });
    await bot.tap("pro:buy:pro_year");
    expect(bot.calls.some((call) => call.method === "sendInvoice")).toBe(false);
    expect(bot.lastText()).toContain("Pro скоро появится");
  });

  it("accepts a pre-checkout query for its own payload", async () => {
    const bot = proBot();
    await bot.preCheckout(buildPayload("pro_month", 1, "n1"));
    expect(bot.calls.at(-1)).toMatchObject({
      method: "answerPreCheckoutQuery",
      payload: { ok: true },
    });
  });

  it("rejects a malformed payload and someone else's invoice, with a reason", async () => {
    const bot = proBot();
    await bot.preCheckout("nonsense");
    await bot.preCheckout(buildPayload("pro_month", 99, "n1"));
    const answers = bot.calls.filter((call) => call.method === "answerPreCheckoutQuery");
    expect(answers).toHaveLength(2);
    for (const answer of answers) {
      expect(answer.payload.ok).toBe(false);
      expect(String(answer.payload.error_message).length).toBeGreaterThan(0);
    }
  });

  it("grants the plan on successful_payment and says what changed", async () => {
    const bot = proBot();
    await bot.pay({ payload: buildPayload("pro_year", 1, "n1"), stars: 1499 });
    expect(bot.user().plan).toBe("pro");
    expect(bot.user().planUntil).toEqual(new Date(NOW.getTime() + 365 * DAY));
    expect(bot.charges()).toHaveLength(1);
    expect(bot.lastText()).toContain("Спасибо");
    expect(bot.lastText()).toContain("Pro до 2027-01-10");
    expect(bot.events.filter((event) => event.name === "payment")).toEqual([
      { name: "payment", props: { product: "pro_year", stars: 1499, recurring: false } },
    ]);
  });

  it("says «продлил» on a renewal and stays quiet on a re-delivered charge", async () => {
    const bot = proBot();
    await bot.pay({
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_1",
      recurring: true,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(bot.lastText()).toContain("продлена");
    const before = bot.texts().length;
    await bot.pay({
      payload: buildPayload("pro_month", 1, "n1"),
      chargeId: "charge_1",
      recurring: true,
    });
    expect(bot.texts()).toHaveLength(before);
    expect(bot.charges()).toHaveLength(1);
    expect(bot.user().planUntil).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it("sends a first subscription charge to /paysupport-free thanks, not «продлил»", async () => {
    const bot = proBot();
    await bot.pay({
      payload: buildPayload("pro_month", 1, "n1"),
      recurring: true,
      firstRecurring: true,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(bot.lastText()).toContain("Спасибо");
  });

  it("points a payment for an unknown product at /paysupport", async () => {
    const bot = proBot();
    await bot.pay({ payload: "deck_a1:1:n1", stars: 99 });
    expect(bot.user().plan).toBe("free");
    expect(bot.charges()).toHaveLength(0);
    expect(bot.lastText()).toContain("/paysupport");
  });
});

describe("/admin refund", () => {
  const paid = async () => {
    const bot = createFakeBot({ card: null, proEnabled: true, adminTgIds: [555] });
    await bot.pay({ payload: buildPayload("pro_year", 1, "n1"), chargeId: "ch_1", stars: 1499 });
    return bot;
  };

  it("refunds through Telegram and shortens the plan it had granted", async () => {
    const bot = await paid();
    await bot.text("/admin refund ch_1");
    expect(bot.calls.find((call) => call.method === "refundStarPayment")?.payload).toEqual({
      user_id: 555,
      telegram_payment_charge_id: "ch_1",
    });
    expect(bot.user()).toMatchObject({ plan: "free", planUntil: null });
    expect(bot.lastText()).toContain("pro_year");
    expect(bot.lastText()).toContain("План теперь: free");
    expect(bot.events.some((event) => event.name === "refund")).toBe(true);
  });

  it("explains an unknown charge id instead of calling Telegram", async () => {
    const bot = await paid();
    await bot.text("/admin refund nope");
    expect(bot.calls.some((call) => call.method === "refundStarPayment")).toBe(false);
    expect(bot.lastText()).toContain("/admin refund");
  });

  it("keeps the plan when Telegram refuses the refund", async () => {
    const bot = createFakeBot({
      card: null,
      proEnabled: true,
      adminTgIds: [555],
      apiFailures: { refundStarPayment: "CHARGE_ALREADY_REFUNDED" },
    });
    await bot.pay({ payload: buildPayload("pro_year", 1, "n1"), chargeId: "ch_1", stars: 1499 });
    await bot.text("/admin refund ch_1");
    expect(bot.lastText()).toContain("CHARGE_ALREADY_REFUNDED");
    expect(bot.user().plan).toBe("pro");
  });

  it("is closed to everyone who is not an admin", async () => {
    const bot = createFakeBot({ card: null, proEnabled: true });
    await bot.pay({ payload: buildPayload("pro_year", 1, "n1"), chargeId: "ch_1", stars: 1499 });
    const before = bot.texts().length;
    await bot.text("/admin refund ch_1");
    expect(bot.calls.some((call) => call.method === "refundStarPayment")).toBe(false);
    expect(bot.texts()).toHaveLength(before);
    expect(bot.user().plan).toBe("pro");
  });
});

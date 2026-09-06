import { type Bot, InlineKeyboard } from "grammy";
import type { User } from "../db/schema.js";
import type { Translate } from "../i18n/index.js";
import { FREE_LIMITS, isPro } from "../services/limits.js";
import { buildPayload } from "../services/paymentService.js";
import { findProduct, offeredProducts, type Product } from "../services/products.js";
import { isAdmin } from "./admin.js";
import { argStr, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { localDate } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { answer, type Screen, send, show } from "./ui.js";

/**
 * `/pro` and the whole Telegram Stars flow (SPEC §9.2).
 *
 * Bot API calls used here, and nothing else: `sendInvoice` for the one-off
 * products, `createInvoiceLink` (+ a URL button) for the monthly subscription —
 * `sendInvoice` has no `subscription_period` parameter — plus
 * `answerPreCheckoutQuery`. Refunds live in `admin.ts` (`refundStarPayment`).
 */

/** Invoice title: Telegram caps it at 32 characters. */
export const INVOICE_TITLE_MAX = 32;
/** Invoice description: capped at 255. */
export const INVOICE_DESCRIPTION_MAX = 255;

export function productTitleKey(product: Product): string {
  return `pro-item-${product.key}`;
}

export function productDescriptionKey(product: Product): string {
  return `pro-item-${product.key}-desc`;
}

export function productButtonKey(product: Product): string {
  return `btn-buy-${product.key}`;
}

/** The current-plan line of the `/pro` screen. */
function planLine(t: Translate, user: User, now: Date, tz: string): string {
  if (user.plan === "lifetime") return t("pro-plan-lifetime");
  if (isPro(user, now)) {
    return user.planUntil
      ? t("pro-plan-pro", { until: localDate(user.planUntil, tz) })
      : t("pro-plan-lifetime");
  }
  return t("pro-plan-free");
}

export interface ProScreenInput {
  user: User;
  now: Date;
  products: readonly Product[];
  /** `PRO_ENABLED`: with the gate off nothing is limited, so nothing is sold… */
  proEnabled: boolean;
  /** …except to admins, who need a live payment to test with (SPEC §9.2). */
  admin: boolean;
}

/**
 * The `/pro` screen. With `PRO_ENABLED=false` a regular user still sees the
 * old «скоро» text; an admin sees the products anyway, so a real Stars payment
 * can be run end to end before the gate is switched on.
 */
export function renderPro(t: Translate, input: ProScreenInput): Screen {
  const { user, now, admin, proEnabled } = input;
  const keyboard = new InlineKeyboard();
  if (!proEnabled && !admin) {
    return { text: t("pro-soon"), keyboard: keyboard.text(t("btn-menu"), cb(NS.menu)) };
  }

  const lines = [
    t("pro-title"),
    t("pro-text", { decks: FREE_LIMITS.ownDecks, notes: FREE_LIMITS.ownNotes }),
    "",
    planLine(t, user, now, user.tz),
  ];
  if (!proEnabled) lines.push(t("pro-admin-note"));

  // A lifetime plan has nothing left to buy; an admin still gets the 1-Star
  // test product, which is the point of it.
  const offered = offeredProducts(input.products, { admin }).filter(
    (product) => user.plan !== "lifetime" || product.adminOnly === true,
  );
  for (const product of offered) {
    keyboard.text(t(productButtonKey(product), { stars: product.stars }), buyData(product)).row();
  }
  keyboard.text(t("btn-menu"), cb(NS.menu));
  return { text: lines.join("\n"), keyboard };
}

export function buyData(product: Product): string {
  return cb(NS.pro, "buy", product.id);
}

/** The thank-you note after a successful charge. */
export function renderThanks(
  t: Translate,
  input: { planUntil: Date | null; tz: string; recurring: boolean },
): Screen {
  const lines = [t(input.recurring ? "pay-renewed" : "pay-thanks")];
  lines.push(
    input.planUntil === null
      ? t("pro-plan-lifetime")
      : t("pro-plan-pro", { until: localDate(input.planUntil, input.tz) }),
  );
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text(t("btn-menu"), cb(NS.menu)),
  };
}

export function installPro(bot: Bot<BotContext>, deps: BotDeps): void {
  const products = deps.payments.products;

  const screen = async (ctx: BotContext): Promise<void> => {
    deps.events.record(ctx.user.id, "pro_screen", {});
    await show(
      ctx,
      renderPro(ctx.t.bind(ctx), {
        user: ctx.user,
        now: deps.now(),
        products,
        proEnabled: deps.config.PRO_ENABLED,
        admin: isAdmin(deps, ctx.user.tgId),
      }),
    );
  };

  bot.command("pro", screen);

  bot.callbackQuery(cb(NS.pro), async (ctx) => {
    await answer(ctx);
    await screen(ctx);
  });

  bot.callbackQuery(/^pro:buy:/u, async (ctx) => {
    await answer(ctx);
    const admin = isAdmin(deps, ctx.user.tgId);
    const id = argStr(parseCallback(ctx.callbackQuery.data)!, 0) ?? "";
    const product = findProduct(products, id);
    const allowed =
      product !== null && (deps.config.PRO_ENABLED || admin) && (admin || !product.adminOnly);
    if (!allowed) {
      await screen(ctx);
      return;
    }
    await sendInvoice(ctx, deps, product);
  });

  // Answer within 10 seconds or Telegram fails the payment for the user.
  bot.on("pre_checkout_query", async (ctx) => {
    const check = deps.payments.check(ctx.preCheckoutQuery.invoice_payload, ctx.user.id);
    if (check.ok) {
      await ctx.answerPreCheckoutQuery(true);
      return;
    }
    deps.logger.warn(
      { reason: check.reason, user: ctx.user.id },
      "rejected a Stars pre-checkout query",
    );
    await ctx.answerPreCheckoutQuery(false, { error_message: ctx.t("pay-rejected") });
  });

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const result = await deps.payments.apply({
      user: ctx.user,
      payload: payment.invoice_payload,
      chargeId: payment.telegram_payment_charge_id,
      stars: payment.total_amount,
      now: deps.now(),
      recurring: payment.is_recurring === true,
      expiresAt: payment.subscription_expiration_date
        ? new Date(payment.subscription_expiration_date * 1000)
        : null,
    });

    if (result.kind === "unknown") {
      deps.logger.error(
        { charge: payment.telegram_payment_charge_id, payload: payment.invoice_payload },
        "paid for a product this build does not sell",
      );
      await send(ctx, { text: ctx.t("pay-unknown") });
      return;
    }
    if (result.kind === "duplicate") {
      // Telegram re-delivered a charge we have already granted: say nothing.
      deps.logger.info(
        { charge: payment.telegram_payment_charge_id },
        "ignored a duplicate successful_payment",
      );
      return;
    }

    ctx.setUser(result.user);
    await send(
      ctx,
      renderThanks(ctx.t.bind(ctx), {
        planUntil: result.grant.planUntil,
        tz: ctx.user.tz,
        // A first subscription charge carries `is_first_recurring` too; only a
        // later one should read as «продлил».
        recurring: payment.is_recurring === true && payment.is_first_recurring !== true,
      }),
    );
  });
}

/**
 * One invoice. A subscription has to go through `createInvoiceLink` —
 * `subscription_period` exists there and nowhere else — so it reaches the user
 * as a URL button instead of Telegram's built-in pay button.
 */
async function sendInvoice(ctx: BotContext, deps: BotDeps, product: Product): Promise<void> {
  const t = ctx.t.bind(ctx);
  const title = t(productTitleKey(product)).slice(0, INVOICE_TITLE_MAX);
  const description = t(productDescriptionKey(product)).slice(0, INVOICE_DESCRIPTION_MAX);
  const payload = buildPayload(product.id, ctx.user.id);
  const prices = [{ label: title, amount: product.stars }];
  const chatId = ctx.chat?.id ?? ctx.user.tgId;

  if (product.subscriptionPeriod !== undefined) {
    const link = await ctx.api.createInvoiceLink(title, description, payload, "", "XTR", prices, {
      subscription_period: product.subscriptionPeriod,
    });
    await send(ctx, {
      text: t("pay-subscribe", { stars: product.stars }),
      keyboard: new InlineKeyboard().url(
        t(productButtonKey(product), { stars: product.stars }),
        link,
      ),
    });
    deps.logger.info({ user: ctx.user.id, product: product.id }, "created a Stars invoice link");
    return;
  }

  await ctx.api.sendInvoice(chatId, title, description, payload, "XTR", prices, {
    provider_token: "",
  });
  deps.logger.info({ user: ctx.user.id, product: product.id }, "sent a Stars invoice");
}

import { type Bot, GrammyError } from "grammy";
import { startOfLearningDay } from "../core/streak.js";
import type { BotContext, BotDeps } from "./context.js";
import { esc, localDate } from "./format.js";
import { htmlOptions } from "./ui.js";

const REPORTS_SHOWN = 10;
const GRANT_DEFAULT_DAYS = 30;

export function isAdmin(deps: BotDeps, tgId: number): boolean {
  return deps.config.ADMIN_TG_IDS.includes(tgId);
}

/** `/admin`, `/admin pro <tgId> [days]`, `/admin reset <tgId>`, `/admin payments [tgId]` and `/admin refund <chargeId>` (SPEC §13). */
export function installAdmin(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("admin", async (ctx) => {
    if (!isAdmin(deps, ctx.user.tgId)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/u).filter(Boolean);

    if (args[0] === "pro") {
      const tgId = Number(args[1]);
      const days = Number(args[2] ?? GRANT_DEFAULT_DAYS);
      const target = Number.isSafeInteger(tgId) ? await deps.repos.users.findByTgId(tgId) : null;
      if (!target || !Number.isFinite(days)) {
        await ctx.reply(ctx.t("admin-grant-usage"));
        return;
      }
      const until = new Date(deps.now().getTime() + days * 24 * 60 * 60 * 1000);
      await deps.repos.users.update(target.id, { plan: "pro", planUntil: until });
      await ctx.reply(ctx.t("admin-granted", { tgId, until: until.toISOString().slice(0, 10) }));
      return;
    }

    // `/admin payments [tg_id]` — the last charges with their ids, so a refund
    // can be issued without opening the database.
    if (args[0] === "payments") {
      const tgId = args[1] === undefined ? undefined : Number(args[1]);
      const rows = await deps.repos.payments.listRecent(
        10,
        tgId !== undefined && Number.isSafeInteger(tgId) ? tgId : undefined,
      );
      if (rows.length === 0) {
        await ctx.reply(ctx.t("admin-payments-empty"));
        return;
      }
      const lines = rows.map(
        (row) =>
          `${row.createdAt.toISOString().slice(0, 16).replace("T", " ")} · ${row.tgId} · ${esc(row.product)} · ${row.stars} ⭐\n<code>${esc(row.tgChargeId)}</code>`,
      );
      await ctx.reply([ctx.t("admin-payments-title"), ...lines].join("\n"), htmlOptions);
      return;
    }

    // `/admin refund <charge_id>` — the Stars refund of SPEC §9.2. Telegram is
    // asked first; only a refund it accepted may shorten the plan.
    if (args[0] === "refund") {
      const chargeId = args[1] ?? "";
      const found = chargeId ? await deps.payments.lookup(chargeId) : null;
      if (!found) {
        await ctx.reply(ctx.t("admin-refund-usage"));
        return;
      }
      try {
        await ctx.api.refundStarPayment(found.user.tgId, chargeId);
      } catch (error) {
        const reason = error instanceof GrammyError ? error.description : String(error);
        await ctx.reply(ctx.t("admin-refund-failed", { reason: esc(reason) }), htmlOptions);
        return;
      }
      const grant = await deps.payments.revoke({
        payment: found.payment,
        user: found.user,
        now: deps.now(),
      });
      const plan =
        grant === null
          ? ctx.t("admin-refund-plan-kept")
          : ctx.t("admin-refund-plan", {
              plan: grant.plan,
              until: grant.planUntil ? localDate(grant.planUntil, found.user.tz) : "—",
            });
      await ctx.reply(
        `${ctx.t("admin-refunded", {
          tgId: found.user.tgId,
          stars: found.payment.stars,
          product: found.payment.product,
        })}\n${plan}`,
      );
      return;
    }

    if (args[0] === "reset") {
      const tgId = Number(args[1]);
      const target = Number.isSafeInteger(tgId) ? await deps.repos.users.findByTgId(tgId) : null;
      if (!target) {
        await ctx.reply(ctx.t("admin-reset-usage"));
        return;
      }
      await deps.repos.users.resetProgress(target.id);
      await ctx.reply(ctx.t("admin-reset-done", { tgId }));
      return;
    }

    const since = startOfLearningDay(deps.now(), ctx.user.tz);
    const [summary, reports] = await Promise.all([
      deps.repos.stats.adminSummary(since),
      deps.repos.noteReports.listOpen(REPORTS_SHOWN),
    ]);
    const lines = [
      ctx.t("admin-title"),
      ctx.t("admin-users", { total: summary.usersTotal, today: summary.usersToday }),
      ctx.t("admin-activity", {
        sessions: summary.sessionsToday,
        reviews: summary.reviewsToday,
      }),
      "",
      ctx.t("admin-reports", { n: reports.length }),
    ];
    for (const report of reports) {
      lines.push(
        `#${report.id} ${esc(report.front)} — ${esc(report.back)} (${esc(report.deckTitle)})`,
      );
    }
    await ctx.reply(lines.join("\n"), htmlOptions);
  });
}

import type { Bot } from "grammy";
import { startOfLearningDay } from "../core/streak.js";
import type { BotContext, BotDeps } from "./context.js";
import { esc } from "./format.js";
import { htmlOptions } from "./ui.js";

const REPORTS_SHOWN = 10;
const GRANT_DEFAULT_DAYS = 30;

export function isAdmin(deps: BotDeps, tgId: number): boolean {
  return deps.config.ADMIN_TG_IDS.includes(tgId);
}

/** `/admin` and `/admin pro <tgId> [days]` (SPEC §13). */
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

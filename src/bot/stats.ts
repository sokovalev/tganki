import { type Bot, InlineKeyboard } from "grammy";
import { endOfLearningDay, startOfLearningDay } from "../core/streak.js";
import type { CardBuckets, Forecast, ReviewWindows } from "../db/repos/stats.js";
import type { Translate } from "../i18n/index.js";
import type { BotContext, BotDeps } from "./context.js";
import { percent } from "./format.js";
import { cb, NS } from "./keyboards.js";
import { answer, type Screen, show } from "./ui.js";

const WEEK_DAYS = 7;

export interface StatsData {
  windows: ReviewWindows;
  buckets: CardBuckets;
  forecast: Forecast;
  streak: number;
  streakBest: number;
}

/** Text statistics (SPEC §7); charts live in the Mini App [M2]. */
export function renderStats(t: Translate, data: StatsData): Screen {
  const lines = [
    t("stats-title"),
    "",
    t("stats-today", {
      reviews: data.windows.todayReviews,
      accuracy: percent(data.windows.todayCorrect, data.windows.todayReviews),
    }),
    t("stats-week", {
      reviews: data.windows.weekReviews,
      new: data.windows.weekNew,
      accuracy: percent(data.windows.weekCorrect, data.windows.weekReviews),
    }),
    t("stats-streak", { n: data.streak, best: data.streakBest }),
    "",
    t("stats-cards", {
      fresh: data.buckets.fresh,
      learning: data.buckets.learning,
      review: data.buckets.review,
      mature: data.buckets.mature,
    }),
    t("stats-forecast", { tomorrow: data.forecast.tomorrow, week: data.forecast.week }),
  ];
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard()
      .text(t("btn-stats-decks"), cb(NS.stats, "decks"))
      .text(t("btn-menu"), cb(NS.menu)),
  };
}

export async function loadStats(ctx: BotContext, deps: BotDeps): Promise<StatsData> {
  const user = ctx.user;
  const now = deps.now();
  const dayStart = startOfLearningDay(now, user.tz);
  const dayEnd = endOfLearningDay(now, user.tz);
  const weekStart = new Date(dayStart.getTime() - (WEEK_DAYS - 1) * 24 * 60 * 60 * 1000);
  const weekEnd = new Date(dayEnd.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000);
  const [windows, buckets, forecast] = await Promise.all([
    deps.repos.stats.reviewWindows({ userId: user.id, dayStart, weekStart }),
    deps.repos.stats.cardBuckets({ userId: user.id, now }),
    deps.repos.stats.forecast({ userId: user.id, dayEnd, weekEnd }),
  ]);
  return { windows, buckets, forecast, streak: user.streak, streakBest: user.streakBest };
}

export function installStats(bot: Bot<BotContext>, deps: BotDeps): void {
  const render = async (ctx: BotContext): Promise<void> => {
    await show(ctx, renderStats(ctx.t.bind(ctx), await loadStats(ctx, deps)));
  };

  bot.command("stats", render);
  bot.callbackQuery("st", async (ctx) => {
    await answer(ctx);
    await render(ctx);
  });

  bot.callbackQuery("st:decks", async (ctx) => {
    await answer(ctx);
    const t = ctx.t.bind(ctx);
    const rows = await deps.repos.decks.listSubscribedWithCounts({
      userId: ctx.user.id,
      now: deps.now(),
    });
    const lines = [t("stats-by-deck-title")];
    if (rows.length === 0) lines.push(t("decks-empty"));
    for (const row of rows) {
      lines.push(
        `${row.deck.title} — ${t("stats-deck-row", {
          learned: row.learned,
          total: row.total,
          due: row.due,
        })}`,
      );
    }
    await show(ctx, {
      text: lines.join("\n"),
      keyboard: new InlineKeyboard()
        .text(t("btn-back"), cb(NS.stats))
        .text(t("btn-menu"), cb(NS.menu)),
    });
  });
}

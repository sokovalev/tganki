import type { Bot } from "grammy";
import { startOfLearningDay } from "../core/streak.js";
import type { Translate } from "../i18n/index.js";
import type { BotContext, BotDeps } from "./context.js";
import { menuKeyboard } from "./keyboards.js";
import { answer, type Screen, show } from "./ui.js";

export interface MenuData {
  due: number;
  fresh: number;
  streak: number;
  deckTitles: string[];
  /** «📝 Слова из текста» is offered only when the LLM is configured (§4.3). */
  extract?: boolean;
}

/** Main menu (SPEC §2) — pure, so both locales can be asserted in tests. */
export function renderMenu(t: Translate, data: MenuData): Screen {
  const lines = [
    `${t("menu-today", { due: data.due, new: data.fresh })}${
      data.streak > 0 ? `   ${t("menu-streak", { n: data.streak })}` : ""
    }`,
  ];
  lines.push(
    data.deckTitles.length > 0
      ? t("menu-decks", { decks: data.deckTitles.join(", ") })
      : t("menu-no-decks"),
  );
  return {
    text: lines.join("\n"),
    keyboard: menuKeyboard(t, data.due + data.fresh, data.extract ?? false),
  };
}

export async function loadMenu(deps: BotDeps, ctx: BotContext): Promise<MenuData> {
  const user = ctx.user;
  const now = deps.now();
  const [counters, decks] = await Promise.all([
    deps.repos.stats.menuCounters({
      userId: user.id,
      now,
      dayStart: startOfLearningDay(now, user.tz),
      defaultNewLimit: user.dailyNewLimit,
    }),
    deps.repos.decks.listSubscribed(user.id),
  ]);
  return {
    due: counters.due,
    fresh: counters.newAvailable,
    streak: user.streak,
    deckTitles: decks.map((row) => row.deck.title),
    extract: deps.extract.llm !== null,
  };
}

export async function showMenu(ctx: BotContext, deps: BotDeps): Promise<void> {
  await show(ctx, renderMenu(ctx.t.bind(ctx), await loadMenu(deps, ctx)));
}

export function installMenu(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command("menu", async (ctx) => {
    await showMenu(ctx, deps);
  });
  bot.callbackQuery("m", async (ctx) => {
    await answer(ctx);
    await showMenu(ctx, deps);
  });
}

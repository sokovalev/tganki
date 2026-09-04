import type { MiddlewareFn } from "grammy";
import type { UsersRepo } from "../../db/repos/users.js";
import { pickLocale } from "../../i18n/index.js";
import type { BotContext } from "../context.js";

/** Rough timezone guess before the user answers "сколько у тебя сейчас времени". */
export function guessTimezone(languageCode: string | undefined): string {
  const code = (languageCode ?? "").slice(0, 2).toLowerCase();
  if (code === "ru") return "Europe/Moscow";
  if (code === "uk") return "Europe/Kyiv";
  return "UTC";
}

export interface UserMiddlewareDeps {
  users: UsersRepo;
  now: () => Date;
}

/**
 * Loads (or creates) the `users` row for `ctx.from`, attaches it to the
 * context and switches the i18n locale to the user's UI language.
 */
export function userMiddleware(deps: UserMiddlewareDeps): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;

    const locale = pickLocale(from.language_code);
    let user = await deps.users.ensure({
      tgId: from.id,
      uiLang: locale,
      langTo: locale,
      tz: guessTimezone(from.language_code),
      onboardingStep: "ui_lang",
    });

    // Any inbound message proves the user did not block us after all (SPEC §6.2).
    if (user.blockedAt !== null) {
      await deps.users.clearBlocked(user.id);
      user = { ...user, blockedAt: null };
    }

    ctx.user = user;
    ctx.setUser = (updated) => {
      ctx.user = updated;
      if (updated.uiLang !== locale) ctx.i18n.useLocale(updated.uiLang);
    };
    ctx.answered = false;
    ctx.i18n.useLocale(user.uiLang);

    await next();
  };
}

/**
 * Draft revisions (SPEC §4.1, §4.3, §11).
 *
 * `pending_payload` holds one draft per user, but Telegram keeps every message
 * the bot ever sent on screen. Without a revision, «➕ Добавить» on a preview
 * from ten minutes ago would happily save the word the user typed a second ago.
 *
 * So every draft — a word waiting for its translation, a generated preview, a
 * duplicate screen, a checklist of words found in a text — is stamped with a
 * revision that only ever grows, and every button of that draft carries the
 * revision in its callback data (`a:g:<rev>`, `x:t:<rev>:<i>`, …). A tap whose
 * revision is not the current one is answered with a toast and loses its
 * keyboard, so the dead message stops inviting taps.
 *
 * The counter lives in the payload and survives the payload being cleared:
 * `clearDraft` keeps `{ rev }` behind, otherwise revisions would restart at 1
 * after every save and an old button could match a new draft again.
 */

import type { PendingPayload, User } from "../db/schema.js";
import { languageTag } from "../i18n/languages.js";
import { argInt, parseCallback } from "./callbacks.js";
import type { BotContext, BotDeps } from "./context.js";
import { answer, dropKeyboard } from "./ui.js";

/** «Мои слова · KA» — the deck a draft lands in unless the user picks another. */
export function personalTitle(ctx: BotContext): string {
  return ctx.t("deck-personal", { lang: languageTag(ctx.user.langFrom ?? "en") });
}

/** Revision of the draft currently on screen; 0 when there is none. */
export function currentRev(user: User): number {
  const rev = user.pendingPayload?.rev;
  return typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0;
}

/** Revision for a draft that starts now — a new word, a new text, a new prompt. */
export function nextRev(user: User): number {
  return currentRev(user) + 1;
}

/**
 * The revision a tap carries (`ns:action:<rev>[:…]`), or null when it belongs
 * to a draft that has since been replaced — then the user gets a toast, the
 * dead message loses its keyboard and nothing else happens.
 */
export async function freshRev(ctx: BotContext, data: string | undefined): Promise<number | null> {
  const parsed = parseCallback(data);
  const rev = parsed ? argInt(parsed, 0) : null;
  if (rev !== null && rev > 0 && rev === currentRev(ctx.user)) return rev;
  await answer(ctx, ctx.t("toast-stale"));
  await dropKeyboard(ctx);
  return null;
}

/** Stores a draft and stamps it with `rev`; the pending question is cleared. */
export async function saveDraft(
  ctx: BotContext,
  deps: BotDeps,
  rev: number,
  payload: Omit<PendingPayload, "rev">,
): Promise<void> {
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, null, {
      now: deps.now(),
      payload: { ...payload, rev },
    }),
  );
}

/** Stores a draft together with the question its screen is asking. */
export async function saveDraftAsking(
  ctx: BotContext,
  deps: BotDeps,
  pending: string,
  rev: number,
  payload: Omit<PendingPayload, "rev">,
): Promise<void> {
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, pending, {
      now: deps.now(),
      payload: { ...payload, rev },
    }),
  );
}

/** Ends the draft: the question goes, the revision counter stays. */
export async function clearDraft(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rev = currentRev(ctx.user);
  ctx.setUser(
    await deps.repos.users.setPendingInput(ctx.user.id, null, {
      now: deps.now(),
      ...(rev > 0 ? { payload: { rev } } : {}),
    }),
  );
}

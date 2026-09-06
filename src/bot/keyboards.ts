import { InlineKeyboard } from "grammy";
import type { Translate } from "../i18n/index.js";
import { encodeCallback } from "./callbacks.js";

/** Callback namespaces. Keep them short — 64 bytes is the whole budget. */
export const NS = {
  menu: "m",
  learn: "l",
  session: "s",
  rate: "r",
  card: "c",
  add: "a",
  decks: "d",
  stats: "st",
  settings: "set",
  onboarding: "o",
  leech: "lch",
  pro: "pro",
  admin: "adm",
  /** «Слова из текста» (SPEC §4.3): `x:t:<rev>:<i>`, `x:add:<rev>`, … */
  extract: "x",
  /** A button that does nothing, e.g. the page indicator in the deck list. */
  noop: "nop",
} as const;

export const cb = encodeCallback;

/**
 * Main menu (SPEC §2). «📝 Слова из текста» only appears when generation is
 * configured — without a key it would be a button that can only apologize.
 */
export function menuKeyboard(t: Translate, total: number, extract = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(t("btn-learn", { n: total }), cb(NS.learn))
    .row()
    .text(t("btn-add"), cb(NS.add, "start"))
    .text(t("btn-decks"), cb(NS.decks))
    .row();
  if (extract) keyboard.text(t("btn-extract"), cb(NS.extract, "ask")).row();
  return keyboard.text(t("btn-stats"), cb(NS.stats)).text(t("btn-settings"), cb(NS.settings));
}

export function menuButton(t: Translate): InlineKeyboard {
  return new InlineKeyboard().text(t("btn-menu"), cb(NS.menu));
}

/** Appends a "‹ Назад" row pointing at an arbitrary callback. */
export function withBack(keyboard: InlineKeyboard, t: Translate, data: string): InlineKeyboard {
  return keyboard.row().text(t("btn-back"), data);
}

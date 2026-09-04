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
  noop: "x",
} as const;

export const cb = encodeCallback;

/** Main menu (SPEC §2). */
export function menuKeyboard(t: Translate, total: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("btn-learn", { n: total }), cb(NS.learn))
    .row()
    .text(t("btn-add"), cb(NS.add, "start"))
    .text(t("btn-decks"), cb(NS.decks))
    .row()
    .text(t("btn-stats"), cb(NS.stats))
    .text(t("btn-settings"), cb(NS.settings));
}

export function menuButton(t: Translate): InlineKeyboard {
  return new InlineKeyboard().text(t("btn-menu"), cb(NS.menu));
}

/** Appends a "‹ Назад" row pointing at an arbitrary callback. */
export function withBack(keyboard: InlineKeyboard, t: Translate, data: string): InlineKeyboard {
  return keyboard.row().text(t("btn-back"), data);
}

import { fileURLToPath } from "node:url";
import { I18n } from "@grammyjs/i18n";
import type { BotContext } from "../bot/context.js";

export const SUPPORTED_LOCALES = ["ru", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ru";

/** `locales/` sits next to `src/` in the repo and next to `dist/` in the image. */
export const LOCALES_DIR = fileURLToPath(new URL("../../locales", import.meta.url));

/** ru/uk speakers get Russian, everyone else English (SPEC §1). */
export function pickLocale(languageCode: string | undefined): Locale {
  const code = (languageCode ?? "").slice(0, 2).toLowerCase();
  return code === "ru" || code === "uk" || code === "be" || code === "kk" ? "ru" : "en";
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function createI18n(directory = LOCALES_DIR): I18n<BotContext> {
  const i18n = new I18n<BotContext>({
    defaultLocale: DEFAULT_LOCALE,
    // Fluent wraps placeables in bidi isolates by default, which shows up as
    // invisible junk in Telegram messages and in test assertions.
    fluentBundleOptions: { useIsolating: false },
  });
  i18n.loadLocalesDirSync(directory);
  return i18n;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Standalone translator for services, cron jobs and tests (no grammY context). */
export function translator(i18n: I18n<BotContext>, locale: string): Translate {
  const safe = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  return (key, vars) => i18n.t(safe, key, vars);
}

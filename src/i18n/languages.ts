/**
 * Static language directory. Replaces the LLM language resolver: the onboarding
 * "Другой…" step, the settings screen and deck titles all read from here.
 *
 * `aliases` are matched case-insensitively together with the code, the native
 * name and the ru/en names, so "Georgian", "грузинский", "ქართული" and "ka"
 * all resolve to the same entry.
 */
export interface LanguageInfo {
  /** ISO 639-1 code. */
  code: string;
  flag: string;
  /** Endonym, used on buttons. */
  native: string;
  /** Name in Russian, nominative. */
  ru: string;
  /** Name in English. */
  en: string;
  aliases: readonly string[];
}

function entry(
  code: string,
  flag: string,
  native: string,
  ru: string,
  en: string,
  aliases: readonly string[] = [],
): LanguageInfo {
  return { code, flag, native, ru, en, aliases };
}

export const LANGUAGES: readonly LanguageInfo[] = [
  entry("en", "🇬🇧", "English", "английский", "English", ["английский язык", "инглиш"]),
  entry("de", "🇩🇪", "Deutsch", "немецкий", "German", ["немецкий язык", "дойч"]),
  entry("es", "🇪🇸", "Español", "испанский", "Spanish", ["испанский язык", "espanol"]),
  entry("ka", "🇬🇪", "ქართული", "грузинский", "Georgian", ["грузинский язык", "kartuli"]),
  entry("fr", "🇫🇷", "Français", "французский", "French", ["французский язык", "francais"]),
  entry("it", "🇮🇹", "Italiano", "итальянский", "Italian", ["итальянский язык"]),
  entry("pt", "🇵🇹", "Português", "португальский", "Portuguese", [
    "португальский язык",
    "portugues",
  ]),
  entry("ru", "🇷🇺", "Русский", "русский", "Russian", ["русский язык"]),
  entry("uk", "🇺🇦", "Українська", "украинский", "Ukrainian", ["украинский язык", "ukrainska"]),
  entry("tr", "🇹🇷", "Türkçe", "турецкий", "Turkish", ["турецкий язык", "turkce"]),
  entry("zh", "🇨🇳", "中文", "китайский", "Chinese", ["китайский язык", "mandarin", "путунхуа"]),
  entry("ja", "🇯🇵", "日本語", "японский", "Japanese", ["японский язык", "nihongo"]),
  entry("ko", "🇰🇷", "한국어", "корейский", "Korean", ["корейский язык"]),
  entry("ar", "🇸🇦", "العربية", "арабский", "Arabic", ["арабский язык"]),
  entry("he", "🇮🇱", "עברית", "иврит", "Hebrew", ["ивритский", "hebrew"]),
  entry("pl", "🇵🇱", "Polski", "польский", "Polish", ["польский язык"]),
  entry("cs", "🇨🇿", "Čeština", "чешский", "Czech", ["чешский язык", "cestina"]),
  entry("kk", "🇰🇿", "Қазақша", "казахский", "Kazakh", ["казахский язык", "qazaqsha"]),
  entry("hy", "🇦🇲", "Հայերեն", "армянский", "Armenian", ["армянский язык"]),
  entry("az", "🇦🇿", "Azərbaycan", "азербайджанский", "Azerbaijani", ["азербайджанский язык"]),
  entry("uz", "🇺🇿", "O‘zbekcha", "узбекский", "Uzbek", ["узбекский язык", "ozbekcha"]),
  entry("el", "🇬🇷", "Ελληνικά", "греческий", "Greek", ["греческий язык"]),
  entry("nl", "🇳🇱", "Nederlands", "нидерландский", "Dutch", ["голландский", "нидерландский язык"]),
  entry("sv", "🇸🇪", "Svenska", "шведский", "Swedish", ["шведский язык"]),
  entry("no", "🇳🇴", "Norsk", "норвежский", "Norwegian", ["норвежский язык", "nb", "nn"]),
  entry("da", "🇩🇰", "Dansk", "датский", "Danish", ["датский язык"]),
  entry("fi", "🇫🇮", "Suomi", "финский", "Finnish", ["финский язык"]),
  entry("hu", "🇭🇺", "Magyar", "венгерский", "Hungarian", ["венгерский язык"]),
  entry("ro", "🇷🇴", "Română", "румынский", "Romanian", ["румынский язык", "молдавский", "romana"]),
  entry("sr", "🇷🇸", "Српски", "сербский", "Serbian", ["сербский язык", "srpski"]),
  entry("bg", "🇧🇬", "Български", "болгарский", "Bulgarian", ["болгарский язык"]),
  entry("hr", "🇭🇷", "Hrvatski", "хорватский", "Croatian", ["хорватский язык"]),
  entry("hi", "🇮🇳", "हिन्दी", "хинди", "Hindi", ["хинди язык"]),
  entry("id", "🇮🇩", "Indonesia", "индонезийский", "Indonesian", ["индонезийский язык"]),
  entry("vi", "🇻🇳", "Tiếng Việt", "вьетнамский", "Vietnamese", ["вьетнамский язык"]),
  entry("th", "🇹🇭", "ไทย", "тайский", "Thai", ["тайский язык"]),
  entry("fa", "🇮🇷", "فارسی", "персидский", "Persian", ["фарси", "персидский язык", "farsi"]),
  entry("la", "🏛", "Latina", "латынь", "Latin", ["латинский", "латинский язык"]),
  entry("eo", "🌍", "Esperanto", "эсперанто", "Esperanto", []),
  entry("sq", "🇦🇱", "Shqip", "албанский", "Albanian", ["албанский язык"]),
];

const byCode = new Map(LANGUAGES.map((lang) => [lang.code, lang]));

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "");
}

const index = new Map<string, LanguageInfo>();
for (const lang of LANGUAGES) {
  for (const key of [lang.code, lang.native, lang.ru, lang.en, ...lang.aliases]) {
    const normalized = normalize(key);
    if (!index.has(normalized)) index.set(normalized, lang);
  }
}

/** Case-insensitive lookup by code, endonym, ru/en name or alias. Null when unknown. */
export function findLanguage(text: string): LanguageInfo | null {
  return index.get(normalize(text)) ?? null;
}

export function getLanguage(code: string): LanguageInfo | null {
  return byCode.get(code.trim().toLowerCase()) ?? null;
}

/** Language name in the UI language, falling back to the raw code. */
export function languageName(code: string, uiLang: string): string {
  const lang = getLanguage(code);
  if (!lang) return code.toUpperCase();
  return uiLang === "ru" ? lang.ru : lang.en;
}

/** "🇬🇧 English" — what goes on a button. */
export function languageButton(code: string): string {
  const lang = getLanguage(code);
  return lang ? `${lang.flag} ${lang.native}` : code.toUpperCase();
}

/** Short tag used in deck titles: «Мои слова · EN». */
export function languageTag(code: string): string {
  return code.trim().toUpperCase();
}

/** Languages that ship with builtin decks; also the onboarding shortcuts. */
export const FEATURED_LANGUAGES = ["en", "de", "es", "ka"] as const;

/**
 * Shortcuts on the «На какой язык переводить?» picker (SPEC §1 step 3, §8).
 * Anything else is reachable through «Другой…» and the table above.
 */
export const TARGET_LANGUAGES = ["ru", "en", "uk"] as const;

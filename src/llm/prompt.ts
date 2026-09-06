/**
 * Prompt for §4.1a "AI card generation".
 *
 * Everything a model needs in order to produce a `GeneratedCard` lives here:
 * the system prompt (stable, so providers can cache it), the JSON schema sent
 * as `response_format`, a zod schema for validating what comes back and the
 * post-processing applied before the card is shown. The bot
 * (`src/llm/generator.ts`) and the offline eval (`scripts/llm-eval/`) share it,
 * so a run of the harness measures exactly what production sends.
 */

import { z } from "zod";
import type { ExtractedWord, ExtractedWords, GeneratedCard } from "./types.js";

/** Part-of-speech vocabulary. Mirrors the `tags` used by the builtin decks. */
export const ALLOWED_POS = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "numeral",
  "preposition",
  "postposition",
  "conjunction",
  "particle",
  "interjection",
  "determiner",
  "phrase",
  "letter",
  "other",
] as const;

export type Pos = (typeof ALLOWED_POS)[number];

export interface KaLetter {
  /** Mkhedruli letter. */
  letter: string;
  /** IPA used by `data/decks/ka-ru-*.json`. */
  ipa: string;
}

/**
 * The Georgian letter table our decks transcribe with: aspirates carry `ʰ`,
 * ejectives carry `ʼ`, affricates use the tie bar. Single source of truth for
 * both the prompt and the transcription check in `checks.ts`.
 */
export const KA_LETTER_TABLE: readonly KaLetter[] = [
  { letter: "ა", ipa: "ɑ" },
  { letter: "ბ", ipa: "b" },
  { letter: "გ", ipa: "ɡ" },
  { letter: "დ", ipa: "d" },
  { letter: "ე", ipa: "ɛ" },
  { letter: "ვ", ipa: "v" },
  { letter: "ზ", ipa: "z" },
  { letter: "თ", ipa: "tʰ" },
  { letter: "ი", ipa: "i" },
  { letter: "კ", ipa: "kʼ" },
  { letter: "ლ", ipa: "l" },
  { letter: "მ", ipa: "m" },
  { letter: "ნ", ipa: "n" },
  { letter: "ო", ipa: "ɔ" },
  { letter: "პ", ipa: "pʼ" },
  { letter: "ჟ", ipa: "ʒ" },
  { letter: "რ", ipa: "r" },
  { letter: "ს", ipa: "s" },
  { letter: "ტ", ipa: "tʼ" },
  { letter: "უ", ipa: "u" },
  { letter: "ფ", ipa: "pʰ" },
  { letter: "ქ", ipa: "kʰ" },
  { letter: "ღ", ipa: "ɣ" },
  { letter: "ყ", ipa: "qʼ" },
  { letter: "შ", ipa: "ʃ" },
  { letter: "ჩ", ipa: "t͡ʃʰ" },
  { letter: "ც", ipa: "t͡sʰ" },
  { letter: "ძ", ipa: "d͡z" },
  { letter: "წ", ipa: "t͡sʼ" },
  { letter: "ჭ", ipa: "t͡ʃʼ" },
  { letter: "ხ", ipa: "x" },
  { letter: "ჯ", ipa: "d͡ʒ" },
  { letter: "ჰ", ipa: "h" },
];

/** Every character that may legally appear in a Georgian transcription. */
export const KA_IPA_CHARS: ReadonlySet<string> = new Set([
  ...KA_LETTER_TABLE.flatMap((entry) => [...entry.ipa]),
  " ",
  "-",
]);

const KA_TABLE_LINE = KA_LETTER_TABLE.map((entry) => `${entry.letter}=${entry.ipa}`).join(" ");

/**
 * System prompt. Keep it stable: changing it invalidates prompt caches and
 * makes runs from different days incomparable, and a wording change that alters
 * the cards themselves should bump `CACHE_VERSION` in `cache.ts` as well.
 *
 * v2 (2026-09-06) folds in what the judge flagged in run `railway-1`: no
 * parentheses or transliterations in `back`, Georgian masdars are verbs with a
 * verb gloss, natural verb-final Georgian examples, an idiomatic example for
 * postpositions and `detectedLang: "und"` for junk instead of an invented card.
 */
export const SYSTEM_PROMPT = `You build one flashcard for a language-learning bot from a single word or short phrase typed by a user.

You are given langFrom (the language the user is learning), langTo (the user's native language, always a language they read fluently) and the raw text they typed. The text may be in langFrom OR in langTo, may contain typos, may be an inflected form, and for Georgian may be typed in Latin transliteration.

Return one JSON object with exactly these fields:
- front: the canonical dictionary form IN langFrom. Never in langTo. If the user typed langTo, translate first and put the langFrom word here.
- back: 1-3 most common meanings in langTo, comma-separated, lowercase. Meanings only — no parentheses, no usage or register comments, no transliteration of front into langTo letters ("шашлык", never "шашлык, мцвади"). Two meanings are usually better than three. When front is a verb (a Georgian masdar counts as a verb), the first meaning is the langTo verb in the infinitive: "писать", not "письмо (процесс)".
- transcription: IPA for front, without slashes or brackets. Empty string when the writing system already tells the reader how to pronounce it.
- example: ONE short natural sentence in langFrom (3-8 words, A1-A2 vocabulary) that actually uses the word from front. End it with a full stop, question or exclamation mark.
- exampleTr: a natural translation of example into langTo.
- pos: part of speech in English, one of: ${ALLOWED_POS.join(", ")}.
- detectedLang: ISO 639-1 code of the language the user actually typed in, not the language you answer in. When the user typed langTo — their own language, expecting the langFrom card — detectedLang is langTo and front is still the langFrom word. Use "und" when the input is not a word or phrase at all.

Canonical form rules:
- Fix typos silently and card the corrected word.
- Reduce inflected forms to the dictionary form: plural to singular, conjugated verb to the citation form. This applies to SINGLE words only.
- Multi-word input (a phrase, a collocation, a short sentence) is kept exactly as typed as "front" when it is already in langFrom: do not convert «სახლში ვარ» into «სახლში ყოფნა» or «I am home» into «be home». Translate the phrase as a whole, give its transcription, and use the phrase itself in the example.
- English: verbs in the bare infinitive ("run"). Phrasal verbs keep the particle ("give up", "look forward to") and get pos "phrase".
- German: every noun gets its definite article and a capital letter — "der Tisch", "das Haus", "die Blume". Verbs in the infinitive ("gehen"). Keep ß where standard German uses it.
- Spanish: every noun gets its article — "la mesa", "el libro", "el agua" (feminine nouns starting with a stressed a- take "el"). Verbs in the infinitive, reflexives keep -se ("levantarse"). Keep accents.
- Georgian: verbs ALWAYS as the masdar (verbal noun): "კითხვა", "წერა", "მუშაობა" — never a conjugated form like "ვკითხულობ". A masdar headword gets pos "verb" and a verbal back ("писать"), not a noun gloss. Nouns in the nominative with the -ი ending where it belongs ("სახლი"). Postpositions are written with a leading hyphen: "-ში", "-თვის", "-ზე", and their example is an everyday phrase that really uses them ("სახლში ვარ." for "-ში", not a made-up sentence). Latin transliteration input is converted to Mkhedruli: "gamarjoba" -> "გამარჯობა". front for langFrom=ka must contain Mkhedruli letters only.

Georgian transcription must use exactly this letter table (aspirates marked ʰ, ejectives marked ʼ, affricates with the tie bar):
${KA_TABLE_LINE}

Example rules:
- The sentence must be something a native speaker would actually say, with natural word order — not a word-for-word calque of langTo.
- Georgian is verb-final: the verb goes last and a time word goes first — "დღეს მზე ანათებს.", not "მზე დღეს ანათებს.".
- For a Georgian masdar the sentence naturally uses a conjugated form of that same verb; keep it short and idiomatic.

If the input is not a word or a short phrase at all (an emoji, random letters, a URL, a whole sentence), do not invent anything: return the trimmed input as front, empty back, transcription, example and exampleTr, pos "other" and detectedLang "und".

Examples.

langFrom=en langTo=ru, input "running":
{"front":"run","back":"бежать, бег","transcription":"rʌn","example":"I run every morning.","exampleTr":"Я бегаю каждое утро.","pos":"verb","detectedLang":"en"}

langFrom=en langTo=ru, input "неохотный" (the user typed their native language):
{"front":"reluctant","back":"неохотный, нежелающий","transcription":"rɪˈlʌktənt","example":"He was reluctant to answer.","exampleTr":"Он неохотно отвечал.","pos":"adjective","detectedLang":"ru"}

langFrom=de langTo=ru, input "tisch":
{"front":"der Tisch","back":"стол","transcription":"deːɐ̯ tɪʃ","example":"Das Buch liegt auf dem Tisch.","exampleTr":"Книга лежит на столе.","pos":"noun","detectedLang":"de"}

langFrom=ka langTo=ru, input "ვკითხულობ":
{"front":"კითხვა","back":"читать, спрашивать","transcription":"kʼitʰxvɑ","example":"წიგნს ვკითხულობ.","exampleTr":"Я читаю книгу.","pos":"verb","detectedLang":"ka"}

langFrom=ka langTo=ru, input "წერა":
{"front":"წერა","back":"писать","transcription":"t͡sʼɛrɑ","example":"დედას წერილს ვწერ.","exampleTr":"Я пишу письмо маме.","pos":"verb","detectedLang":"ka"}

langFrom=ka langTo=ru, input "-ში":
{"front":"-ში","back":"в, внутри","transcription":"ʃi","example":"სახლში ვარ.","exampleTr":"Я дома.","pos":"postposition","detectedLang":"ka"}

langFrom=en langTo=ru, input "🙂🙂🙂":
{"front":"🙂🙂🙂","back":"","transcription":"","example":"","exampleTr":"","pos":"other","detectedLang":"und"}`;

/** JSON Schema shape sent as `response_format`. Structural, not stylistic. */
export type JsonSchema = Record<string, unknown>;

export const CARD_SCHEMA_NAME = "flashcard";

export const CARD_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["front", "back", "transcription", "example", "exampleTr", "pos", "detectedLang"],
  properties: {
    front: { type: "string", description: "Canonical dictionary form in langFrom." },
    back: { type: "string", description: "1-3 meanings in langTo, comma-separated." },
    transcription: { type: "string", description: "IPA without slashes or brackets." },
    example: { type: "string", description: "One short sentence in langFrom." },
    exampleTr: { type: "string", description: "Translation of example into langTo." },
    pos: { type: "string", enum: [...ALLOWED_POS], description: "Part of speech in English." },
    detectedLang: { type: "string", description: "ISO 639-1 of the language the user typed." },
  },
};

export const generatedCardSchema = z.object({
  front: z.string(),
  back: z.string(),
  transcription: z.string(),
  example: z.string(),
  exampleTr: z.string(),
  pos: z.string(),
  detectedLang: z.string(),
});

export interface CardRequestInput {
  text: string;
  langFrom: string;
  langTo: string;
}

/** The user turn. Deliberately terse: ~40 tokens. */
/** Two or more whitespace-separated tokens: a phrase, kept verbatim as `front`. */
export function isPhrase(text: string): boolean {
  return collapseWhitespace(text).split(" ").length > 1;
}

/** Trailing sentence punctuation is not part of a headword. */
export function stripTrailingPunctuation(text: string): string {
  return collapseWhitespace(text)
    .replace(/[.!?…]+$/u, "")
    .trim();
}

export function buildUserMessage(input: CardRequestInput): string {
  const hint = isPhrase(input.text)
    ? "\nnote: multi-word input — if it is in langFrom, keep it verbatim as front (no dictionary form)."
    : "";
  return `langFrom=${input.langFrom}\nlangTo=${input.langTo}\ninput: ${input.text}${hint}`;
}

/**
 * System prompt for the `json_object` fallback: providers that reject
 * `json_schema` still honour "reply with JSON of this shape".
 */
export function systemPromptWithSchema(
  system: string = SYSTEM_PROMPT,
  schema: JsonSchema = CARD_JSON_SCHEMA,
): string {
  return `${system}

Reply with a single JSON object and nothing else. No markdown, no code fence. It must validate against this JSON Schema:
${JSON.stringify(schema)}`;
}

/** trim + collapse every run of whitespace to a single space. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const WRAPPERS: readonly [string, string][] = [
  ["/", "/"],
  ["[", "]"],
  ["(", ")"],
  ["⟨", "⟩"],
  ["{", "}"],
];

/** Strips the slashes/brackets some models wrap IPA in: "/kʼitʰxvɑ/" -> "kʼitʰxvɑ". */
export function normalizeTranscription(value: string): string {
  let out = collapseWhitespace(value);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
        out = collapseWhitespace(out.slice(open.length, out.length - close.length));
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Pulls the JSON object out of a model reply that may be fenced or padded with
 * prose. Throws when there is nothing object-shaped in it.
 */
export function extractJson(text: string): unknown {
  const withoutFence = text
    .replace(/^\s*```(?:json)?\s*/iu, "")
    .replace(/\s*```\s*$/u, "")
    .trim();
  const candidates = [withoutFence];
  const first = withoutFence.indexOf("{");
  const last = withoutFence.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(withoutFence.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("response is not JSON");
}

/** Exactly what production would do between the raw reply and the stored note. */
export function postProcess(raw: unknown): GeneratedCard {
  const parsed = generatedCardSchema.parse(raw);
  return {
    front: collapseWhitespace(parsed.front),
    back: collapseWhitespace(parsed.back),
    transcription: normalizeTranscription(parsed.transcription),
    example: collapseWhitespace(parsed.example),
    exampleTr: collapseWhitespace(parsed.exampleTr),
    pos: collapseWhitespace(parsed.pos),
    detectedLang: collapseWhitespace(parsed.detectedLang).toLowerCase(),
  };
}

/** Parse + validate + post-process in one step. Throws on anything unusable. */
export function parseCard(text: string): GeneratedCard {
  return postProcess(extractJson(text));
}

/**
 * Prompt for §4.3 "words from a text".
 *
 * Same shape as the card prompt above: a stable system prompt, the JSON schema
 * sent as `response_format`, a zod schema for the reply and the
 * post-processing production applies before the checklist is drawn.
 */

/** Hard cap on the checklist; the prompt asks for it and the parser enforces it. */
export const MAX_EXTRACTED_WORDS = 25;

/** Levels the extraction prompt understands; anything else falls back to A2. */
export const EXTRACT_LEVELS = ["A1", "A2", "B1"] as const;
export type ExtractLevel = (typeof EXTRACT_LEVELS)[number];
export const DEFAULT_EXTRACT_LEVEL: ExtractLevel = "A2";

export const EXTRACT_SCHEMA_NAME = "unknown_words";

/**
 * System prompt. Keep it stable — the same reason as `SYSTEM_PROMPT`: a change
 * makes runs from different days incomparable. Nothing here is cached per
 * text, so a wording change costs nothing but comparability.
 */
export const EXTRACT_SYSTEM_PROMPT = `You pick the words worth learning out of a text for a language-learning bot.

You are given langFrom (the language the user is learning), langTo (the user's native language), the user's approximate level (A1, A2 or B1) and the text they sent.

Return one JSON object with exactly these fields:
- detectedLang: ISO 639-1 code of the language the TEXT is written in — not the language you answer in. Use "und" when the text is not running text in any language.
- words: an array of at most ${MAX_EXTRACTED_WORDS} entries, ordered by usefulness (the words that unlock the most of this text first).

Each entry has exactly these fields:
- front: the dictionary form IN langFrom, exactly as a flashcard headword: English verbs in the bare infinitive ("give up" keeps its particle), German nouns with their article and a capital letter ("der Tisch"), Spanish nouns with their article ("la mesa"), Georgian verbs as the masdar ("კითხვა") and nouns in the nominative ("სახლი").
- back: a short gloss in langTo, one or two meanings, comma-separated, lowercase. The meaning the word carries IN THIS TEXT comes first. No parentheses, no grammar notes.
- inText: the word exactly as it appears in the text, in the form it appears in.

Rules:
- Only words that really occur in the text. Never invent vocabulary to pad the list.
- Skip proper nouns (people, places, brands), numbers, dates, units and interjections.
- Skip words the learner already knows at their level: at A1 skip only greetings and the most basic function words; at A2 also skip roughly the 1000 most frequent words of langFrom; at B1 skip roughly the 2000 most frequent.
- One entry per dictionary form: no duplicates, even if the word occurs several times or in several forms.
- A multi-word expression is allowed when the phrase is what has to be learned ("give up", "სახლში ვარ").
- If detectedLang is not langFrom, return an empty words array — do not translate the text.
- If everything in the text is below the level, return an empty words array. An empty list is a perfectly good answer.

Examples.

langFrom=en langTo=ru level=A2, input "The tenant was reluctant to sign the lease, so the landlord offered a discount.":
{"detectedLang":"en","words":[{"front":"reluctant","back":"неохотный, нежелающий","inText":"reluctant"},{"front":"tenant","back":"арендатор, квартирант","inText":"tenant"},{"front":"landlord","back":"арендодатель, хозяин квартиры","inText":"landlord"},{"front":"lease","back":"договор аренды","inText":"lease"},{"front":"discount","back":"скидка","inText":"discount"}]}

langFrom=ka langTo=ru level=A1, input "დღეს ბაზარში წავედი და ხილი ვიყიდე. გამყიდველი ძალიან თავაზიანი იყო.":
{"detectedLang":"ka","words":[{"front":"ბაზარი","back":"рынок, базар","inText":"ბაზარში"},{"front":"ხილი","back":"фрукты","inText":"ხილი"},{"front":"ყიდვა","back":"покупать","inText":"ვიყიდე"},{"front":"გამყიდველი","back":"продавец","inText":"გამყიდველი"},{"front":"თავაზიანი","back":"вежливый","inText":"თავაზიანი"}]}

langFrom=en langTo=ru level=A2, input "Привет, как дела?":
{"detectedLang":"ru","words":[]}`;

export const EXTRACT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["detectedLang", "words"],
  properties: {
    detectedLang: { type: "string", description: "ISO 639-1 of the language of the text." },
    words: {
      type: "array",
      description: `Up to ${MAX_EXTRACTED_WORDS} unknown words, most useful first.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["front", "back", "inText"],
        properties: {
          front: { type: "string", description: "Dictionary form in langFrom." },
          back: { type: "string", description: "Short gloss in langTo." },
          inText: { type: "string", description: "The form used in the text." },
        },
      },
    },
  },
};

export const extractedWordsSchema = z.object({
  detectedLang: z.string(),
  words: z.array(
    z.object({
      front: z.string(),
      back: z.string(),
      // Some providers drop a field the schema marks as required.
      inText: z.string().optional(),
    }),
  ),
});

export interface ExtractRequestInput {
  text: string;
  langFrom: string;
  langTo: string;
  level: string;
}

export function buildExtractUserMessage(input: ExtractRequestInput): string {
  return `langFrom=${input.langFrom}\nlangTo=${input.langTo}\nlevel=${input.level}\ntext:\n${input.text}`;
}

/**
 * Which script a language is written in. Used to drop words the model made up
 * in the wrong alphabet — for langFrom=ka a "front" in Latin letters is not a
 * Georgian word, whatever the model thought (SPEC §4.3).
 */
const SCRIPTS: Record<string, RegExp> = {
  ka: /\p{Script=Georgian}/u,
  hy: /\p{Script=Armenian}/u,
  el: /\p{Script=Greek}/u,
  he: /\p{Script=Hebrew}/u,
  ar: /\p{Script=Arabic}/u,
  fa: /\p{Script=Arabic}/u,
  ur: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
  ko: /\p{Script=Hangul}/u,
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  be: /\p{Script=Cyrillic}/u,
  bg: /\p{Script=Cyrillic}/u,
  sr: /\p{Script=Cyrillic}/u,
  mk: /\p{Script=Cyrillic}/u,
  kk: /\p{Script=Cyrillic}/u,
};

const LATIN = /\p{Script=Latin}/u;

/** The script `lang` is written in; Latin for everything we do not list. */
export function scriptOf(lang: string): RegExp {
  return SCRIPTS[lang.toLowerCase()] ?? LATIN;
}

/**
 * True when most of the letters in `text` belong to the script of `lang`.
 * "Most", not "all": a Georgian phrase may carry a Latin abbreviation.
 */
export function matchesScript(text: string, lang: string): boolean {
  const script = scriptOf(lang);
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) return false;
  const hits = letters.filter((char) => script.test(char)).length;
  return hits * 2 >= letters.length;
}

/**
 * Exactly what production does between the raw reply and the checklist:
 * whitespace collapsed, junk and duplicates dropped, words that are not in the
 * script of langFrom dropped, and the list capped.
 */
export function postProcessExtraction(raw: unknown, langFrom: string): ExtractedWords {
  const parsed = extractedWordsSchema.parse(raw);
  const seen = new Set<string>();
  const words: ExtractedWord[] = [];
  for (const entry of parsed.words) {
    const front = collapseWhitespace(entry.front);
    const back = collapseWhitespace(entry.back);
    if (front === "" || back === "") continue;
    if (!matchesScript(front, langFrom)) continue;
    const key = front.normalize("NFC").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ front, back, inText: collapseWhitespace(entry.inText ?? "") || front });
    if (words.length >= MAX_EXTRACTED_WORDS) break;
  }
  return { detectedLang: collapseWhitespace(parsed.detectedLang).toLowerCase(), words };
}

/** Parse + validate + post-process in one step. Throws on anything unusable. */
export function parseExtraction(text: string, langFrom: string): ExtractedWords {
  return postProcessExtraction(extractJson(text), langFrom);
}

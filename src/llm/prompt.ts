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
import type { GeneratedCard } from "./types.js";

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
- Reduce inflected forms to the dictionary form: plural to singular, conjugated verb to the citation form.
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
export function buildUserMessage(input: CardRequestInput): string {
  return `langFrom=${input.langFrom}\nlangTo=${input.langTo}\ninput: ${input.text}`;
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

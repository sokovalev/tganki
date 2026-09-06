/**
 * Contract between the bot layer and the LLM layer.
 * The bot depends only on these interfaces; `src/llm/anthropic.ts` implements them.
 */

export interface GenerateCardInput {
  /** Raw user input: a word or short phrase, in either langFrom or langTo. */
  text: string;
  /** ISO 639-1 code of the language being learned (e.g. "en"). */
  langFrom: string;
  /** ISO 639-1 code of the user's native language (e.g. "ru"). */
  langTo: string;
}

export interface GeneratedCard {
  /** Canonical dictionary form in langFrom ("run", "der Tisch", "კითხვა"). */
  front: string;
  /** 1–3 most common meanings in langTo, comma-separated. */
  back: string;
  /** IPA without slashes; empty string when not applicable. */
  transcription: string;
  /** One short natural sentence in langFrom using the word. */
  example: string;
  /** Translation of the example into langTo. */
  exampleTr: string;
  /** Part of speech in English: noun, verb, adjective, adverb, phrase, ... */
  pos: string;
  /** ISO 639-1 code of the language the user actually typed in. */
  detectedLang: string;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    /** "timeout" | "unavailable" | "refused" | "invalid_output" */
    public readonly reason: "timeout" | "unavailable" | "refused" | "invalid_output",
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface CardGenerator {
  /** Throws GenerationError on failure. Implementations should cache by (langFrom, langTo, normalized text). */
  generate(input: GenerateCardInput): Promise<GeneratedCard>;
}

export interface ResolvedLanguage {
  /** ISO 639-1 (or 639-3 when no 639-1 exists). */
  code: string;
  /** Language name in the user's UI language. */
  name: string;
}

export interface LanguageResolver {
  /** Maps a free-text language name in any language ("грузинский", "Georgian") to a code; null if unrecognized. */
  resolve(input: { text: string; uiLang: string }): Promise<ResolvedLanguage | null>;
}

/** Input for §4.3 "words from a text". */
export interface ExtractWordsInput {
  /** The text to look through, already stripped of URLs and capped in length. */
  text: string;
  /** ISO 639-1 code of the language being learned. */
  langFrom: string;
  /** ISO 639-1 code of the user's native language. */
  langTo: string;
  /** CEFR level guess ("A1" | "A2" | "B1"): words below it are skipped. */
  level: string;
}

export interface ExtractedWord {
  /** Dictionary form in langFrom. */
  front: string;
  /** Short gloss in langTo. */
  back: string;
  /** The form as it appears in the text. */
  inText: string;
}

export interface ExtractedWords {
  /** ISO 639-1 code of the language the text is written in, "und" when unclear. */
  detectedLang: string;
  /** Unknown words, most useful first. */
  words: ExtractedWord[];
}

export interface WordExtractor {
  /** Throws GenerationError on failure. Never cached: every text is different. */
  extract(input: ExtractWordsInput): Promise<ExtractedWords>;
}

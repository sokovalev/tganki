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

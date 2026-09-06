/**
 * The production `CardGenerator` (SPEC §4.1a): OpenRouter + the shared prompt,
 * with every failure mapped onto a `GenerationError` reason the bot knows how
 * to fall back from.
 */

import { findLanguage, languageName } from "../i18n/languages.js";
import type { Logger } from "../logger.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  OpenRouterClient,
  OpenRouterError,
} from "./openrouter.js";
import {
  buildUserMessage,
  CARD_JSON_SCHEMA,
  isPhrase,
  parseCard,
  SYSTEM_PROMPT,
  stripTrailingPunctuation,
} from "./prompt.js";
import {
  type CardGenerator,
  type GenerateCardInput,
  type GeneratedCard,
  GenerationError,
  type LanguageResolver,
} from "./types.js";

/** ISO 639-3 "undetermined": what the prompt returns for junk input. */
export const UNDETERMINED = "und";

/**
 * Answer budget for one card. The client default (600) is not enough for a
 * reasoning model: the thinking tokens eat it and the JSON arrives cut in half
 * («{"front":"უნდომელი","back":"reluctant»). Same value as the eval harness.
 */
export const CARD_MAX_TOKENS = 4_000;

export interface OpenRouterGeneratorOptions {
  apiKey: string;
  /** OpenRouter model id, e.g. "google/gemini-3.7-flash". */
  model: string;
  baseUrl?: string;
  /** Only sent when set; reasoning models need it to leave room for the answer. */
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
  /** Injected in tests so nothing touches the network. */
  fetchImpl?: FetchLike;
  /** Injected in tests so retry backoff does not really wait. */
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}

function isTimeout(error: unknown): boolean {
  if (error instanceof OpenRouterError) return error.status === 408;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError";
  // some fetch implementations surface it as "AbortError" instead.
  return name === "TimeoutError" || name === "AbortError";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a failed HTTP call onto a reason: a timeout of its own, and everything
 * else — 429, 5xx, a dead socket, a bad key — onto "unavailable", because the
 * bot reacts to all of them the same way: ask the user for the translation.
 */
export function toTransportError(error: unknown): GenerationError {
  if (error instanceof GenerationError) return error;
  if (isTimeout(error)) return new GenerationError(message(error), "timeout");
  return new GenerationError(message(error), "unavailable");
}

export function createOpenRouterCardGenerator(
  options: OpenRouterGeneratorOptions,
): CardGenerator & { model: string } {
  const client = new OpenRouterClient({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: 3,
    referer: "https://github.com/tganki/tganki",
    title: "tganki",
  });

  return {
    model: options.model,

    async generate(input: GenerateCardInput): Promise<GeneratedCard> {
      const started = Date.now();
      let text: string;
      /** "length" = the model ran out of tokens mid-answer. */
      let finishReason: string | null = null;
      try {
        const reply = await client.chat({
          model: options.model,
          system: SYSTEM_PROMPT,
          user: buildUserMessage(input),
          schema: CARD_JSON_SCHEMA,
          maxTokens: CARD_MAX_TOKENS,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        });
        text = reply.text;
        finishReason = reply.finishReason;
      } catch (error) {
        const failure = toTransportError(error);
        options.logger.warn(
          { err: error, reason: failure.reason, model: options.model },
          "card generation failed",
        );
        throw failure;
      }

      let card: GeneratedCard;
      try {
        card = parseCard(text);
      } catch (error) {
        // A truncated answer looks exactly like an invalid one, so say which it
        // was: `finish_reason: "length"` means the budget was too small.
        const truncated = finishReason === "length";
        options.logger.warn(
          {
            err: error,
            model: options.model,
            finishReason,
            maxTokens: CARD_MAX_TOKENS,
            reply: text.slice(0, 400),
          },
          truncated
            ? "card generation was cut off before the JSON ended"
            : "card generation returned unparseable output",
        );
        throw new GenerationError(
          truncated
            ? `${message(error)} (truncated: finish_reason=length, max_tokens=${CARD_MAX_TOKENS})`
            : message(error),
          "invalid_output",
        );
      }

      // Junk input comes back as `und` with empty fields, and a card without a
      // headword or a translation is nothing we can show: both are failures,
      // so the bot falls back to asking for the translation by hand.
      if (card.detectedLang === UNDETERMINED || card.front === "" || card.back === "") {
        options.logger.info(
          { model: options.model, detectedLang: card.detectedLang },
          "card generation returned nothing usable",
        );
        throw new GenerationError(`unusable card for "${input.text}"`, "invalid_output");
      }

      // A phrase typed in the language being learned stays the user's phrase:
      // only single words are reduced to their dictionary form.
      if (isPhrase(input.text) && card.detectedLang === input.langFrom) {
        const typed = stripTrailingPunctuation(input.text);
        if (typed !== "" && typed !== card.front) {
          options.logger.debug({ typed, generated: card.front }, "keeping the typed phrase");
          card = { ...card, front: typed };
        }
      }

      options.logger.debug(
        { model: options.model, latencyMs: Date.now() - started, front: card.front },
        "card generated",
      );
      return card;
    },
  };
}

/**
 * The language resolver the bot actually uses: the static table from
 * `src/i18n/languages.ts`, no LLM involved (SPEC decision, §1 "Другой…").
 */
export function createStaticLanguageResolver(): LanguageResolver {
  return {
    async resolve(input) {
      const found = findLanguage(input.text);
      if (!found) return null;
      return { code: found.code, name: languageName(found.code, input.uiLang) };
    },
  };
}

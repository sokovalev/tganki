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
import { buildUserMessage, CARD_JSON_SCHEMA, parseCard, SYSTEM_PROMPT } from "./prompt.js";
import {
  type CardGenerator,
  type GenerateCardInput,
  type GeneratedCard,
  GenerationError,
  type LanguageResolver,
} from "./types.js";

/** ISO 639-3 "undetermined": what the prompt returns for junk input. */
export const UNDETERMINED = "und";

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
      try {
        const reply = await client.chat({
          model: options.model,
          system: SYSTEM_PROMPT,
          user: buildUserMessage(input),
          schema: CARD_JSON_SCHEMA,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        });
        text = reply.text;
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
        options.logger.warn(
          { err: error, model: options.model, reply: text.slice(0, 400) },
          "card generation returned unparseable output",
        );
        throw new GenerationError(message(error), "invalid_output");
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

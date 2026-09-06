/**
 * The production `WordExtractor` (SPEC §4.3): the same OpenRouter client as the
 * card generator, the extraction prompt from `prompt.ts`, and every failure
 * mapped onto a `GenerationError` reason the bot knows how to recover from.
 *
 * Deliberately cache-free: two users never paste the same text, so a cache
 * would only cost a round trip.
 */

import type { Logger } from "../logger.js";
import { toTransportError } from "./generator.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  OpenRouterClient,
  type ResponseMode,
} from "./openrouter.js";
import {
  buildExtractUserMessage,
  EXTRACT_JSON_SCHEMA,
  EXTRACT_SCHEMA_NAME,
  EXTRACT_SYSTEM_PROMPT,
  parseExtraction,
} from "./prompt.js";
import {
  type ExtractedWords,
  type ExtractWordsInput,
  GenerationError,
  type WordExtractor,
} from "./types.js";

/**
 * Answer budget for one extraction. Twenty-five entries of JSON plus a
 * reasoning model's thinking tokens do not fit into the client default (600):
 * the array arrives cut in half and looks like invalid output.
 */
export const EXTRACT_MAX_TOKENS = 4_000;

export interface OpenRouterExtractorOptions {
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
  /** Force a response mode instead of trying `json_schema` first. */
  mode?: ResponseMode;
  logger: Logger;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOpenRouterWordExtractor(
  options: OpenRouterExtractorOptions,
): WordExtractor & { model: string } {
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

    async extract(input: ExtractWordsInput): Promise<ExtractedWords> {
      const started = Date.now();
      let text: string;
      /** "length" = the model ran out of tokens mid-answer. */
      let finishReason: string | null = null;
      try {
        const reply = await client.chat({
          model: options.model,
          system: EXTRACT_SYSTEM_PROMPT,
          user: buildExtractUserMessage(input),
          schema: EXTRACT_JSON_SCHEMA,
          schemaName: EXTRACT_SCHEMA_NAME,
          maxTokens: EXTRACT_MAX_TOKENS,
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        });
        text = reply.text;
        finishReason = reply.finishReason;
      } catch (error) {
        const failure = toTransportError(error);
        options.logger.warn(
          { err: error, reason: failure.reason, model: options.model },
          "word extraction failed",
        );
        throw failure;
      }

      try {
        const result = parseExtraction(text, input.langFrom);
        options.logger.debug(
          {
            model: options.model,
            latencyMs: Date.now() - started,
            words: result.words.length,
            detectedLang: result.detectedLang,
          },
          "words extracted",
        );
        return result;
      } catch (error) {
        // A truncated answer looks exactly like an invalid one, so say which it
        // was: `finish_reason: "length"` means the budget was too small.
        const truncated = finishReason === "length";
        options.logger.warn(
          {
            err: error,
            model: options.model,
            finishReason,
            maxTokens: EXTRACT_MAX_TOKENS,
            reply: text.slice(0, 400),
          },
          truncated
            ? "word extraction was cut off before the JSON ended"
            : "word extraction returned unparseable output",
        );
        throw new GenerationError(
          truncated
            ? `${message(error)} (truncated: finish_reason=length, max_tokens=${EXTRACT_MAX_TOKENS})`
            : message(error),
          "invalid_output",
        );
      }
    },
  };
}

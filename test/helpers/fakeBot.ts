/**
 * A whole bot in memory: real grammY routing, real i18n, the real add service
 * on a fake port — only Telegram and Postgres are stubbed. This is what the
 * pure render tests cannot cover: which handler a message reaches, and what
 * `pending_input` / `pending_payload` look like after it.
 */

import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { installAdd } from "../../src/bot/add.js";
import type { BotContext, BotDeps } from "../../src/bot/context.js";
import { installExtract } from "../../src/bot/extract.js";
import { installOnboarding } from "../../src/bot/onboarding.js";
import { installTextRouter } from "../../src/bot/router.js";
import { installSettings } from "../../src/bot/settings.js";
import { answer } from "../../src/bot/ui.js";
import type { DuplicateNote, FrontClass } from "../../src/db/repos/notes.js";
import type { Deck, NewUser, Note, PendingPayload, User } from "../../src/db/schema.js";
import { normalizeFrontValue } from "../../src/db/sql.js";
import { createI18n } from "../../src/i18n/index.js";
import type { CachedCardGenerator } from "../../src/llm/cache.js";
import type {
  ExtractedWords,
  ExtractWordsInput,
  GenerateCardInput,
  GeneratedCard,
} from "../../src/llm/types.js";
import { type AddPort, createAddService, type LlmSupport } from "../../src/services/addService.js";
import type { EventName, EventRecorder } from "../../src/services/events.js";
import { createExtractService, type ExtractLlm } from "../../src/services/extractService.js";
import { createLimits } from "../../src/services/limits.js";
import { makeUser } from "./fakeSession.js";

export const NOW = new Date("2026-01-10T12:00:00.000Z");
const CHAT_ID = 555;

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "tganki",
  username: "tganki_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface RecordedEvent {
  name: EventName;
  props: Record<string, unknown>;
}

export interface FakeBot {
  bot: Bot<BotContext>;
  deps: BotDeps;
  calls: ApiCall[];
  /** The single in-memory `users` row every handler reads and writes. */
  user(): User;
  setUser(patch: Partial<User>): void;
  notes(): Note[];
  decks(): Deck[];
  duplicates: DuplicateNote[];
  /** Inputs the generator was called with. */
  generations: GenerateCardInput[];
  /** Inputs the word extractor was called with (SPEC §4.3). */
  extractions: ExtractWordsInput[];
  /** Cards materialized for words that already lay in a deck (SPEC §4.3). */
  started: Array<{ noteId: number; due: Date }>;
  /** Analytics written during the run (SPEC §12). */
  events: RecordedEvent[];
  /** Sends a plain text message from the user. */
  text(text: string): Promise<void>;
  /** Sends a message the user forwarded from somewhere else (SPEC §4.3). */
  forward(text: string): Promise<void>;
  /** Taps an inline button. */
  tap(data: string): Promise<void>;
  /** Texts the bot sent or edited, oldest first. */
  texts(): string[];
  lastText(): string;
  /** Callback data of the buttons on the last screen. */
  lastButtons(): string[];
  /** Labels of the buttons on the last screen. */
  lastLabels(): string[];
  /** Texts of the toasts (`answerCallbackQuery`) the bot showed. */
  toasts(): string[];
  /** Raw `reply_markup` of every message the bot sent or edited. */
  markups(): unknown[];
}

export interface FakeBotOptions {
  user?: Partial<User>;
  /** null = no OPENROUTER_API_KEY: the bot stays on the manual flow of §4.1. */
  card?: GeneratedCard | ((input: GenerateCardInput) => GeneratedCard) | null;
  decks?: Deck[];
  duplicates?: DuplicateNote[];
  /** What the word extractor answers; a function may throw to fail the call. */
  extract?: ExtractedWords | ((input: ExtractWordsInput) => ExtractedWords);
  /** Words with a `known_words` row: known however the decks look (§3.7). */
  knownFronts?: string[];
  /** Notes the user can reach, with their card progress (SPEC §4.3). */
  library?: LibraryNote[];
  /** Free-plan gating; off by default, as in the default deployment. */
  proEnabled?: boolean;
  /** `word_generated` events already recorded today (SPEC §9.1). */
  generationsUsed?: number;
  /** `text_extracted` events already recorded today (SPEC §9.1). */
  extractionsUsed?: number;
}

/**
 * One note the user can reach, as `classifyFronts` sees it: a row of `notes`
 * plus what the user has done with it. This is the fixture the classification
 * rules of SPEC §4.3 are written against.
 */
export interface LibraryNote {
  front: string;
  noteId: number;
  deckTitle: string;
  deckId?: number;
  /** The deck belongs to the user — a note of their own, i.e. a duplicate. */
  owned?: boolean;
  /** The user is subscribed to the deck. True unless said otherwise. */
  subscribed?: boolean;
  /**
   * Ratings on the user's card for this note. `undefined` = no card at all,
   * `0` = a card the queue materialized but the user never answered.
   */
  reps?: number;
}

/**
 * JS twin of `notesRepo.classifyFronts` (SPEC §4.3), kept in one place so the
 * fake bot and the classification tests agree on the rules:
 *
 * 1. **known** — a `known_words` row, a card with `reps > 0`, or a note in a
 *    deck the user owns;
 * 2. **inDeck** — a note in a subscribed deck the user does not own, with no
 *    card or an untouched one;
 * 3. **fresh** — anything the map does not mention.
 */
export function classifyFake(input: {
  fronts: readonly string[];
  known: ReadonlySet<string>;
  library: readonly LibraryNote[];
}): Map<string, FrontClass> {
  const classified = new Map<string, FrontClass>();
  for (const front of input.fronts) {
    const norm = normalizeFrontValue(front);
    if (norm === "" || classified.has(norm)) continue;
    if (input.known.has(norm)) {
      classified.set(norm, { kind: "known" });
      continue;
    }
    const rows = input.library.filter((note) => normalizeFrontValue(note.front) === norm);
    if (rows.some((note) => note.owned || (note.reps ?? 0) > 0)) {
      classified.set(norm, { kind: "known" });
      continue;
    }
    const waiting = rows.find((note) => !note.owned && note.subscribed !== false);
    if (waiting) {
      classified.set(norm, {
        kind: "inDeck",
        noteId: waiting.noteId,
        deckId: waiting.deckId ?? 1,
        deckTitle: waiting.deckTitle,
      });
    }
  }
  return classified;
}

export function makeDeck(id: number, ownerId: number | null, title: string): Deck {
  return {
    id,
    ownerId,
    slug: ownerId === null ? `deck-${id}` : null,
    title,
    description: null,
    langFrom: "ka",
    langTo: "ru",
    kind: ownerId === null ? "builtin" : "user",
    level: null,
    isPublic: ownerId === null,
    publicId: null,
    createdAt: NOW,
  };
}

export function duplicateNote(overrides: Partial<DuplicateNote> = {}): DuplicateNote {
  return {
    noteId: 7,
    deckId: 1,
    deckTitle: "Грузинский Top 500 · A1",
    deckOwnerId: null,
    front: "კითხვა",
    back: "чтение",
    position: 74,
    ...overrides,
  };
}

export function createFakeBot(options: FakeBotOptions = {}): FakeBot {
  const state = {
    user: makeUser({ langFrom: "ka", langTo: "ru", uiLang: "ru", ...options.user }),
    notes: [] as Note[],
    decks: [...(options.decks ?? [])],
  };
  const duplicates = [...(options.duplicates ?? [])];
  const generations: GenerateCardInput[] = [];
  const extractions: ExtractWordsInput[] = [];
  const recorded: RecordedEvent[] = [];
  const knownFronts = new Set((options.knownFronts ?? []).map(normalizeFrontValue));
  const started: Array<{ noteId: number; due: Date }> = [];
  let nextNoteId = 1;
  let nextDeckId = 10;

  const port: AddPort = {
    async findDuplicates({ fronts }) {
      const wanted = new Set(fronts.map((front) => front.toLowerCase()));
      return duplicates.filter((note) => wanted.has(note.front.toLowerCase()));
    },
    async createNote({ deckId, front, back, transcription, example, exampleTr }) {
      const note: Note = {
        id: nextNoteId++,
        deckId,
        front,
        back,
        transcription: transcription ?? null,
        example: example ?? null,
        exampleTr: exampleTr ?? null,
        audioFileId: null,
        imageFileId: null,
        tags: [],
        position: state.notes.length,
        createdAt: NOW,
      };
      state.notes.push(note);
      return note;
    },
    async fillNote() {
      return null;
    },
    async createNotes(deckId, pairs) {
      for (const pair of pairs) await port.createNote({ deckId, ...pair });
      return pairs.length;
    },
    async findPersonalDeck(ownerId, langFrom) {
      // Same rule as the repo: the oldest own deck for that learning language.
      return (
        [...state.decks]
          .sort((a, b) => a.id - b.id)
          .find((deck) => deck.ownerId === ownerId && deck.langFrom === langFrom) ?? null
      );
    },
    async createUserDeck({ ownerId, title, langFrom, langTo }) {
      const deck = { ...makeDeck(nextDeckId++, ownerId, title), langFrom, langTo };
      state.decks.push(deck);
      return deck;
    },
    async subscribe() {},
    async findDeck(id) {
      return state.decks.find((deck) => deck.id === id) ?? null;
    },
    async listOwnDecks(ownerId) {
      return state.decks.filter((deck) => deck.ownerId === ownerId);
    },
  };

  const limits = createLimits(
    {
      countOwnDecks: async () => 0,
      countOwnNotes: async () => 0,
      countGenerationsSince: async () => options.generationsUsed ?? 0,
      countExtractionsSince: async () => options.extractionsUsed ?? 0,
    },
    { proEnabled: options.proEnabled ?? false },
  );

  let llm: LlmSupport | null = null;
  if (options.card) {
    const reply = options.card;
    const generateWithMeta = async (input: GenerateCardInput) => {
      generations.push(input);
      return { card: typeof reply === "function" ? reply(input) : reply, cached: false };
    };
    const generator: CachedCardGenerator = {
      generateWithMeta,
      generate: async (input) => (await generateWithMeta(input)).card,
    };
    llm = { model: "test/model", generator };
  }

  const add = createAddService(port, limits, llm);

  let extractLlm: ExtractLlm | null = null;
  if (options.extract && llm) {
    const reply = options.extract;
    extractLlm = {
      ...llm,
      extractor: {
        async extract(input: ExtractWordsInput): Promise<ExtractedWords> {
          extractions.push(input);
          return typeof reply === "function" ? reply(input) : reply;
        },
      },
    };
  }
  const extract = createExtractService({
    port: {
      async classifyFronts({ fronts }) {
        return classifyFake({ fronts, known: knownFronts, library: options.library ?? [] });
      },
      async listSubscribedDecks() {
        return state.decks;
      },
      async startCard({ noteId, due }) {
        started.push({ noteId, due });
        return 900 + started.length;
      },
    },
    limits,
    add,
    llm: extractLlm,
  });

  const events: EventRecorder = {
    record(_userId, name, props) {
      recorded.push({ name, props: props ?? {} });
    },
    async recordAsync(_userId, name, props) {
      recorded.push({ name, props: props ?? {} });
    },
  };

  const users = {
    async update(_id: number, patch: Partial<NewUser>): Promise<User> {
      state.user = { ...state.user, ...patch } as User;
      return state.user;
    },
    async setPendingInput(
      id: number,
      input: string | null,
      opts: { ttlMs?: number; payload?: PendingPayload | null; now?: Date } = {},
    ): Promise<User> {
      const now = opts.now ?? NOW;
      const ttl = opts.ttlMs ?? 10 * 60_000;
      return users.update(id, {
        pendingInput: input,
        pendingInputExpiresAt: input === null ? null : new Date(now.getTime() + ttl),
        // Mirrors the repo: an explicit payload survives even when the pending
        // question is cleared, which is how the draft revision stays monotonic.
        pendingPayload: opts.payload ?? null,
      });
    },
  };

  const repos = {
    users,
    decks: {
      async findById(id: number) {
        return state.decks.find((deck) => deck.id === id) ?? null;
      },
      async listCatalog() {
        return [];
      },
      async subscribe() {},
      async findByRef() {
        return null;
      },
    },
  };

  const i18n = createI18n();
  const deps = {
    config: { PRO_ENABLED: options.proEnabled ?? false },
    db: {},
    repos,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    events,
    i18n,
    sessions: {},
    add,
    extract,
    limits,
    now: () => NOW,
    botUsername: () => "tganki_bot",
  } as unknown as BotDeps;

  const bot = new Bot<BotContext>("12345:TEST", { botInfo: BOT_INFO });
  const calls: ApiCall[] = [];
  let nextMessageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage") {
      const sent = payload as { chat_id: number; text: string };
      return {
        ok: true,
        result: {
          message_id: ++nextMessageId,
          date: 0,
          chat: { id: sent.chat_id, type: "private" },
          text: sent.text,
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });

  bot.use(i18n.middleware());
  bot.use(async (ctx, next) => {
    ctx.user = state.user;
    ctx.setUser = (updated) => {
      state.user = updated;
      ctx.user = updated;
    };
    ctx.answered = false;
    ctx.i18n.useLocale(state.user.uiLang);
    await next();
  });

  installOnboarding(bot, deps);
  installAdd(bot, deps);
  installExtract(bot, deps);
  installSettings(bot, deps);
  installTextRouter(bot, deps);
  bot.on("callback_query", (ctx) => answer(ctx));

  let updateId = 1;
  const from = { id: CHAT_ID, is_bot: false, first_name: "Tester", language_code: "ru" };
  const chat = { id: CHAT_ID, type: "private" as const, first_name: "Tester" };

  const messages = (): ApiCall[] =>
    calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText");

  interface FakeButton {
    text?: string;
    callback_data?: string;
  }

  /** Buttons of the last screen — whatever the bot most recently drew. */
  const lastKeyboard = (): FakeButton[] => {
    const drawn = calls.filter(
      (call) =>
        call.method === "sendMessage" ||
        call.method === "editMessageText" ||
        call.method === "editMessageReplyMarkup",
    );
    const markup = drawn[drawn.length - 1]?.payload.reply_markup as
      | { inline_keyboard: FakeButton[][] }
      | undefined;
    return (markup?.inline_keyboard ?? []).flat();
  };

  return {
    bot,
    deps,
    calls,
    duplicates,
    generations,
    extractions,
    started,
    events: recorded,
    user: () => state.user,
    setUser: (patch) => {
      state.user = { ...state.user, ...patch };
    },
    notes: () => state.notes,
    decks: () => state.decks,

    async text(text: string) {
      // grammY matches commands on the entity, not on the leading slash.
      const command = text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(/\s/u)[0]!.length }]
        : undefined;
      const update = {
        update_id: updateId++,
        message: {
          message_id: updateId + 500,
          date: 0,
          chat,
          from,
          text,
          ...(command ? { entities: command } : {}),
        },
      } as Update;
      await bot.handleUpdate(update);
    },

    async forward(text: string) {
      const update = {
        update_id: updateId++,
        message: {
          message_id: updateId + 500,
          date: 0,
          chat,
          from,
          text,
          forward_origin: { type: "hidden_user", date: 0, sender_user_name: "Someone" },
        },
      } as Update;
      await bot.handleUpdate(update);
    },

    async tap(data: string) {
      const update = {
        update_id: updateId++,
        callback_query: {
          id: String(updateId),
          from,
          chat_instance: "1",
          data,
          message: { message_id: nextMessageId, date: 0, chat, text: "…" },
        },
      } as Update;
      await bot.handleUpdate(update);
    },

    texts: () => messages().map((call) => String(call.payload.text ?? "")),
    lastText: () => {
      const sent = messages();
      return String(sent[sent.length - 1]?.payload.text ?? "");
    },
    lastButtons: () => lastKeyboard().map((button) => button.callback_data ?? ""),
    lastLabels: () => lastKeyboard().map((button) => button.text ?? ""),
    toasts: () =>
      calls
        .filter((call) => call.method === "answerCallbackQuery")
        .map((call) => String(call.payload.text ?? "")),
    markups: () => messages().map((call) => call.payload.reply_markup),
  };
}

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
import { installOnboarding } from "../../src/bot/onboarding.js";
import { installTextRouter } from "../../src/bot/router.js";
import { installSettings } from "../../src/bot/settings.js";
import { answer } from "../../src/bot/ui.js";
import type { DuplicateNote } from "../../src/db/repos/notes.js";
import type { Deck, NewUser, Note, PendingPayload, User } from "../../src/db/schema.js";
import { createI18n } from "../../src/i18n/index.js";
import type { CachedCardGenerator } from "../../src/llm/cache.js";
import type { GenerateCardInput, GeneratedCard } from "../../src/llm/types.js";
import { type AddPort, createAddService, type LlmSupport } from "../../src/services/addService.js";
import { nullEventRecorder } from "../../src/services/events.js";
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
  /** Sends a plain text message from the user. */
  text(text: string): Promise<void>;
  /** Taps an inline button. */
  tap(data: string): Promise<void>;
  /** Texts the bot sent or edited, oldest first. */
  texts(): string[];
  lastText(): string;
  /** Callback data of the buttons on the last screen. */
  lastButtons(): string[];
}

export interface FakeBotOptions {
  user?: Partial<User>;
  /** null = no OPENROUTER_API_KEY: the bot stays on the manual flow of §4.1. */
  card?: GeneratedCard | ((input: GenerateCardInput) => GeneratedCard) | null;
  decks?: Deck[];
  duplicates?: DuplicateNote[];
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
      countGenerationsSince: async () => 0,
    },
    { proEnabled: false },
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
        pendingPayload: input === null ? null : (opts.payload ?? null),
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
    config: { PRO_ENABLED: false },
    db: {},
    repos,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    events: nullEventRecorder(),
    i18n,
    sessions: {},
    add: createAddService(port, limits, llm),
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
  installSettings(bot, deps);
  installTextRouter(bot, deps);
  bot.on("callback_query", (ctx) => answer(ctx));

  let updateId = 1;
  const from = { id: CHAT_ID, is_bot: false, first_name: "Tester", language_code: "ru" };
  const chat = { id: CHAT_ID, type: "private" as const, first_name: "Tester" };

  const messages = (): ApiCall[] =>
    calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText");

  return {
    bot,
    deps,
    calls,
    duplicates,
    generations,
    user: () => state.user,
    setUser: (patch) => {
      state.user = { ...state.user, ...patch };
    },
    notes: () => state.notes,
    decks: () => state.decks,

    async text(text: string) {
      const update = {
        update_id: updateId++,
        message: { message_id: updateId + 500, date: 0, chat, from, text },
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
    lastButtons: () => {
      const sent = messages();
      const markup = sent[sent.length - 1]?.payload.reply_markup as
        | { inline_keyboard: { callback_data?: string }[][] }
        | undefined;
      return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? "");
    },
  };
}

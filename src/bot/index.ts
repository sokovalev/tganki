import { Bot, GrammyError, HttpError } from "grammy";
import type { Config } from "../config.js";
import type { Database } from "../db/index.js";
import { createRepos } from "../db/repos/index.js";
import { createI18n } from "../i18n/index.js";
import { createDbCacheStore, withCache } from "../llm/cache.js";
import { createOpenRouterWordExtractor } from "../llm/extractor.js";
import { createOpenRouterCardGenerator } from "../llm/generator.js";
import type { Logger } from "../logger.js";
import { createReminderSender } from "../reminders/sender.js";
import { createAddService, type LlmSupport } from "../services/addService.js";
import { createEventRecorder } from "../services/events.js";
import { createExtractService, type ExtractLlm } from "../services/extractService.js";
import { createLimits } from "../services/limits.js";
import { createReminderService, type ReminderRunStats } from "../services/reminderService.js";
import { createSessionPort } from "../services/sessionPort.js";
import { createSessionService } from "../services/sessionService.js";
import { installAdd } from "./add.js";
import { installAdmin } from "./admin.js";
import { registerCommands } from "./commands.js";
import type { BotContext, BotDeps } from "./context.js";
import { installDecks } from "./decks.js";
import { installExtract } from "./extract.js";
import { installMenu } from "./menu.js";
import { userMiddleware } from "./middleware/user.js";
import { installMisc } from "./misc.js";
import { installOnboarding } from "./onboarding.js";
import { installTextRouter } from "./router.js";
import { installSession } from "./session.js";
import { installSettings } from "./settings.js";
import { installStats } from "./stats.js";
import { answer } from "./ui.js";

export interface CreateBotOptions {
  config: Config;
  db: Database;
  logger: Logger;
  /** Injected in tests. */
  now?: () => Date;
}

export interface BotHandle {
  bot: Bot<BotContext>;
  deps: BotDeps;
  /** `POST /telegram/<secret>` when a webhook is configured, null in polling mode. */
  webhookPath: string | null;
  /** Registers commands and either sets the webhook or starts long polling. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One reminder cron tick; wired to `reminders/cron.ts` in main. */
  runReminders(now: Date): Promise<ReminderRunStats>;
}

export function createBot(options: CreateBotOptions): BotHandle {
  const { config, db, logger } = options;
  const now = options.now ?? (() => new Date());

  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const repos = createRepos(db);
  const i18n = createI18n();
  const events = createEventRecorder(repos.events, logger);
  const sessionPort = createSessionPort(db, repos);
  const sessions = createSessionService(sessionPort, { proEnabled: config.PRO_ENABLED });
  const limits = createLimits(
    {
      countOwnDecks: (userId) => repos.decks.countOwnedBy(userId),
      countOwnNotes: (userId) => repos.notes.countOwnedBy(userId),
      countGenerationsSince: (userId, since) => repos.events.countGenerationsSince(userId, since),
      countExtractionsSince: (userId, since) =>
        repos.events.countUserEventsSince(userId, "text_extracted", since),
    },
    { proEnabled: config.PRO_ENABLED },
  );
  // AI card generation (SPEC §4.1a) switches itself on with the key; without
  // one the bot stays on the manual flow of §4.1.
  const llm: LlmSupport | null = config.OPENROUTER_API_KEY
    ? {
        model: config.LLM_MODEL,
        generator: withCache(
          createOpenRouterCardGenerator({
            apiKey: config.OPENROUTER_API_KEY,
            model: config.LLM_MODEL,
            timeoutMs: config.LLM_TIMEOUT_MS,
            ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
            ...(config.LLM_REASONING_EFFORT
              ? { reasoningEffort: config.LLM_REASONING_EFFORT }
              : {}),
            logger,
          }),
          createDbCacheStore(db, logger),
          { logger },
        ),
      }
    : null;
  // §4.3 rides on the same key and the same model as §4.1a: the extractor
  // finds the words, the cached card generator fills each of them in.
  const extractLlm: ExtractLlm | null =
    config.OPENROUTER_API_KEY && llm
      ? {
          ...llm,
          extractor: createOpenRouterWordExtractor({
            apiKey: config.OPENROUTER_API_KEY,
            model: config.LLM_MODEL,
            timeoutMs: config.LLM_TIMEOUT_MS,
            ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
            ...(config.LLM_REASONING_EFFORT
              ? { reasoningEffort: config.LLM_REASONING_EFFORT }
              : {}),
            logger,
          }),
        }
      : null;
  const add = createAddService(
    {
      findDuplicates: (input) => repos.notes.findDuplicates(input),
      createNote: (input) => repos.notes.create(input),
      fillNote: (noteId, values) => repos.notes.fillEmpty(noteId, values),
      createNotes: (deckId, pairs) => repos.notes.createMany(deckId, pairs),
      findPersonalDeck: (ownerId, langFrom) => repos.decks.findPersonalDeck(ownerId, langFrom),
      createUserDeck: (input) => repos.decks.createUserDeck(input),
      subscribe: (userId, deckId) => repos.decks.subscribe(userId, deckId),
      findDeck: (id) => repos.decks.findById(id),
      listOwnDecks: (ownerId) => repos.decks.listOwnedBy(ownerId),
    },
    limits,
    llm,
  );

  const extract = createExtractService({
    port: {
      classifyFronts: (input) => repos.notes.classifyFronts(input),
      listSubscribedDecks: async (userId) =>
        (await repos.decks.listSubscribed(userId)).map((row) => row.deck),
      startCard: ({ userId, noteId, due }) =>
        repos.cards.createCard({ userId, noteId, mode: "recognition", due }),
    },
    limits,
    add,
    llm: extractLlm,
  });

  let username = "";
  const deps: BotDeps = {
    config,
    db,
    repos,
    logger,
    events,
    i18n,
    sessions,
    add,
    extract,
    limits,
    now,
    botUsername: () => username,
  };

  bot.use(i18n.middleware());
  bot.use(userMiddleware({ users: repos.users, now }));

  installOnboarding(bot, deps);
  installMenu(bot, deps);
  installSession(bot, deps);
  installAdd(bot, deps);
  installExtract(bot, deps);
  installDecks(bot, deps);
  installStats(bot, deps);
  installSettings(bot, deps);
  installMisc(bot, deps);
  installAdmin(bot, deps);
  installTextRouter(bot, deps);

  // Anything that fell through (an unknown or stale button) still gets closed,
  // otherwise Telegram shows a spinner on the button forever.
  bot.on("callback_query", async (ctx) => {
    await answer(ctx);
  });

  bot.catch((error) => {
    const { ctx } = error;
    const context = { update: ctx.update.update_id, from: ctx.from?.id };
    if (error.error instanceof GrammyError) {
      logger.error({ ...context, description: error.error.description }, "telegram api error");
    } else if (error.error instanceof HttpError) {
      logger.error({ ...context, err: error.error }, "cannot reach telegram");
    } else {
      logger.error({ ...context, err: error.error }, "unhandled bot error");
    }
  });

  const reminders = createReminderService(
    {
      listCandidates: (times) => repos.users.listReminderCandidates(times),
      listStreakNudgeCandidates: (input) => repos.users.listStreakNudgeCandidates(input),
      listWeeklyReportCandidates: (input) => repos.users.listWeeklyReportCandidates(input),
      counters: (input) => repos.stats.menuCounters(input),
      weekly: (input) => repos.stats.weeklyReport(input),
      markReminded: (userId, day) => repos.users.markReminded(userId, day),
      markStreakNudged: (userId, day) => repos.users.markStreakNudged(userId, day),
      markWeeklyReported: (userId, week) => repos.users.markWeeklyReported(userId, week),
      markBlocked: async (userId, at) => {
        await repos.users.markBlocked(userId, at);
        events.record(userId, "blocked", {});
      },
      record: (userId, name, props) => events.record(userId, name, props),
    },
    createReminderSender(bot, i18n, logger),
    { logger },
  );

  const webhookPath = config.PUBLIC_URL ? `/telegram/${config.WEBHOOK_SECRET ?? "updates"}` : null;

  return {
    bot,
    deps,
    webhookPath,

    async start() {
      await bot.init();
      username = bot.botInfo.username;
      await registerCommands(bot, i18n);
      try {
        await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
      } catch (error) {
        logger.warn({ err: error }, "could not set the chat menu button");
      }

      if (config.PUBLIC_URL && webhookPath) {
        const url = new URL(webhookPath, config.PUBLIC_URL).toString();
        await bot.api.setWebhook(url, {
          drop_pending_updates: false,
          ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
        });
        logger.info({ url }, "telegram webhook registered");
        return;
      }

      await bot.api.deleteWebhook({ drop_pending_updates: false });
      // Long polling never resolves; run it detached so startup can continue.
      void bot.start({ onStart: () => logger.info("telegram long polling started") });
    },

    async stop() {
      await bot.stop();
    },

    runReminders: (at: Date) => reminders.run(at),
  };
}

export type { BotContext, BotDeps };

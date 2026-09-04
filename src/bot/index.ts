import { Bot, GrammyError, HttpError } from "grammy";
import type { Config } from "../config.js";
import type { Database } from "../db/index.js";
import { createRepos } from "../db/repos/index.js";
import { createI18n } from "../i18n/index.js";
import type { Logger } from "../logger.js";
import { createReminderSender } from "../reminders/sender.js";
import { createAddService } from "../services/addService.js";
import { createEventRecorder } from "../services/events.js";
import { createLimits } from "../services/limits.js";
import { createReminderService, type ReminderRunStats } from "../services/reminderService.js";
import { createSessionPort } from "../services/sessionPort.js";
import { createSessionService } from "../services/sessionService.js";
import { installAdd } from "./add.js";
import { installAdmin } from "./admin.js";
import { registerCommands } from "./commands.js";
import type { BotContext, BotDeps } from "./context.js";
import { installDecks } from "./decks.js";
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
  const sessions = createSessionService(sessionPort);
  const limits = createLimits(
    {
      countOwnDecks: (userId) => repos.decks.countOwnedBy(userId),
      countOwnNotes: (userId) => repos.notes.countOwnedBy(userId),
    },
    { proEnabled: config.PRO_ENABLED },
  );
  const add = createAddService(
    {
      findDuplicates: (input) => repos.notes.findDuplicates(input),
      createNote: (input) => repos.notes.create(input),
      createNotes: (deckId, pairs) => repos.notes.createMany(deckId, pairs),
      findPersonalDeck: (ownerId, langFrom) => repos.decks.findPersonalDeck(ownerId, langFrom),
      createUserDeck: (input) => repos.decks.createUserDeck(input),
      subscribe: (userId, deckId) => repos.decks.subscribe(userId, deckId),
      findDeck: (id) => repos.decks.findById(id),
      listOwnDecks: (ownerId) => repos.decks.listOwnedBy(ownerId),
    },
    limits,
  );

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
      counters: (input) => repos.stats.menuCounters(input),
      markReminded: (userId, day) => repos.users.markReminded(userId, day),
      markBlocked: async (userId, at) => {
        await repos.users.markBlocked(userId, at);
        events.record(userId, "blocked", {});
      },
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

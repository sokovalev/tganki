import { serve } from "@hono/node-server";
import { webhookCallback } from "grammy";
import { createApp } from "./app.js";
import { createBot } from "./bot/index.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { startReminderCron } from "./reminders/cron.js";

const config = loadConfig();
const logger = createLogger({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development",
});

const database = createDb(config.DATABASE_URL);

if (!(await database.ping())) {
  logger.error("cannot reach the database");
  process.exit(1);
}

const telegram = createBot({ config, db: database.db, logger });

const app = createApp({
  ping: database.ping,
  webhook: telegram.webhookPath
    ? {
        path: telegram.webhookPath,
        handler: webhookCallback(telegram.bot, "hono", {
          ...(config.WEBHOOK_SECRET ? { secretToken: config.WEBHOOK_SECRET } : {}),
        }),
      }
    : null,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info(
    { port: info.port, env: config.NODE_ENV, mode: telegram.webhookPath ? "webhook" : "polling" },
    "tganki is listening",
  );
});

await telegram.start();

const reminders = startReminderCron({ run: telegram.runReminders, logger });

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  reminders.stop();
  server.close();
  await telegram.stop();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

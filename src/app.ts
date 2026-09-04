import { Hono } from "hono";

export interface AppDeps {
  ping: () => Promise<boolean>;
}

/**
 * HTTP surface. Today: healthcheck only. The Telegram webhook is mounted here
 * later (`app.post("/webhook/:secret", webhookCallback(bot, "hono"))`).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const db = await deps.ping();
    return c.json({ status: db ? "ok" : "degraded", db }, db ? 200 : 503);
  });

  return app;
}

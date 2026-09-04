import { Hono, type Context as HonoContext } from "hono";

export interface WebhookMount {
  /** e.g. `/telegram/<secret>` */
  path: string;
  handler: (c: HonoContext) => Promise<Response>;
}

export interface AppDeps {
  ping: () => Promise<boolean>;
  /** Set in webhook mode; omitted when the bot runs on long polling. */
  webhook?: WebhookMount | null;
}

/** HTTP surface: healthcheck plus, in webhook mode, the Telegram endpoint. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const db = await deps.ping();
    return c.json({ status: db ? "ok" : "degraded", db }, db ? 200 : 503);
  });

  if (deps.webhook) {
    app.post(deps.webhook.path, (c) => deps.webhook!.handler(c));
  }

  return app;
}

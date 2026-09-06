import type { I18n, I18nFlavor } from "@grammyjs/i18n";
import type { Context } from "grammy";
import type { Config } from "../config.js";
import type { Database } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { User } from "../db/schema.js";
import type { Logger } from "../logger.js";
import type { AddService } from "../services/addService.js";
import type { EventRecorder } from "../services/events.js";
import type { ExtractService } from "../services/extractService.js";
import type { Limits } from "../services/limits.js";
import type { PaymentService } from "../services/paymentService.js";
import type { SessionService } from "../services/sessionService.js";

/** Attached by `middleware/user.ts` before any handler runs. */
export interface UserFlavor {
  /** The row for `ctx.from`, created on first contact. */
  user: User;
  /** Replaces `ctx.user` after a write so later handlers see fresh data. */
  setUser(user: User): void;
  /** Set by `answer()`; whatever is left unanswered is closed by the router. */
  answered: boolean;
}

export type BotContext = Context & I18nFlavor & UserFlavor;

export interface BotDeps {
  config: Config;
  db: Database;
  repos: Repos;
  logger: Logger;
  events: EventRecorder;
  i18n: I18n<BotContext>;
  sessions: SessionService;
  add: AddService;
  /** «Слова из текста» (SPEC §4.3). */
  extract: ExtractService;
  limits: Limits;
  /** Telegram Stars: products, invoices, grants and expiry (SPEC §9.2). */
  payments: PaymentService;
  /** Injected for tests; defaults to `() => new Date()`. */
  now: () => Date;
  /** Bot username, resolved on start; used to build share links. */
  botUsername: () => string;
}

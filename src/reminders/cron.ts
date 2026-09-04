import type { Logger } from "../logger.js";
import type { ReminderRunStats } from "../services/reminderService.js";

export const TICK_MS = 60_000;

export interface ReminderCronDeps {
  run(now: Date): Promise<ReminderRunStats>;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
}

export interface ReminderCron {
  stop(): void;
  /** Runs one tick immediately; a no-op while another tick is still running. */
  tick(): Promise<void>;
}

/**
 * Fires once a minute. Ticks never overlap: a slow run (many reminders, a
 * throttled Telegram) simply skips the next minute instead of piling up.
 */
export function startReminderCron(deps: ReminderCronDeps): ReminderCron {
  const interval = deps.intervalMs ?? TICK_MS;
  const now = deps.now ?? (() => new Date());
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      deps.logger.debug("reminder tick skipped: previous run still in flight");
      return;
    }
    running = true;
    try {
      const stats = await deps.run(now());
      if (stats.eligible > 0) deps.logger.info(stats, "reminders processed");
    } catch (error) {
      deps.logger.error({ err: error }, "reminder tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}

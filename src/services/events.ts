import type { EventName, EventsRepo } from "../db/repos/events.js";
import type { Logger } from "../logger.js";

export type { EventName };

/**
 * Analytics is never allowed to break a user flow, so `record` is fire and
 * forget: it returns immediately and swallows (but logs) write failures.
 */
export interface EventRecorder {
  record(userId: number | null, name: EventName, props?: Record<string, unknown>): void;
  /** Await the write — used in tests to make assertions deterministic. */
  recordAsync(
    userId: number | null,
    name: EventName,
    props?: Record<string, unknown>,
  ): Promise<void>;
}

export function createEventRecorder(repo: EventsRepo, logger: Logger): EventRecorder {
  const recordAsync = async (
    userId: number | null,
    name: EventName,
    props?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await repo.insert({ userId, name, ...(props ? { props } : {}) });
    } catch (error) {
      logger.warn({ err: error, event: name }, "failed to record event");
    }
  };

  return {
    record(userId, name, props) {
      void recordAsync(userId, name, props);
    },
    recordAsync,
  };
}

/** No-op recorder for tests and for code paths without a database. */
export function nullEventRecorder(): EventRecorder {
  return {
    record() {},
    async recordAsync() {},
  };
}

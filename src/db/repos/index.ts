import type { Database } from "../index.js";
import { createCardsRepo } from "./cards.js";
import { createDecksRepo } from "./decks.js";
import { createEventsRepo } from "./events.js";
import { createNoteReportsRepo } from "./noteReports.js";
import { createNotesRepo } from "./notes.js";
import { createPaymentsRepo } from "./payments.js";
import { createReviewLogsRepo } from "./reviewLogs.js";
import { createSessionsRepo } from "./sessions.js";
import { createStatsRepo } from "./stats.js";
import { createUsersRepo } from "./users.js";

export function createRepos(db: Database) {
  return {
    users: createUsersRepo(db),
    decks: createDecksRepo(db),
    notes: createNotesRepo(db),
    cards: createCardsRepo(db),
    sessions: createSessionsRepo(db),
    reviewLogs: createReviewLogsRepo(db),
    noteReports: createNoteReportsRepo(db),
    payments: createPaymentsRepo(db),
    events: createEventsRepo(db),
    stats: createStatsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

export * from "./cards.js";
export * from "./decks.js";
export * from "./events.js";
export * from "./noteReports.js";
export * from "./notes.js";
export * from "./payments.js";
export * from "./reviewLogs.js";
export * from "./sessions.js";
export * from "./stats.js";
export * from "./users.js";

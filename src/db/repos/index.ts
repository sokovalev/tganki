import type { Database } from "../index.js";
import { createCardsRepo } from "./cards.js";
import { createDecksRepo } from "./decks.js";
import { createNotesRepo } from "./notes.js";
import { createReviewLogsRepo } from "./reviewLogs.js";
import { createSessionsRepo } from "./sessions.js";
import { createUsersRepo } from "./users.js";

export function createRepos(db: Database) {
  return {
    users: createUsersRepo(db),
    decks: createDecksRepo(db),
    notes: createNotesRepo(db),
    cards: createCardsRepo(db),
    sessions: createSessionsRepo(db),
    reviewLogs: createReviewLogsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

export * from "./cards.js";
export * from "./decks.js";
export * from "./notes.js";
export * from "./reviewLogs.js";
export * from "./sessions.js";
export * from "./users.js";

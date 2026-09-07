import { startOfLearningDay } from "../core/streak.js";
import type { User } from "../db/schema.js";

/** Free-plan budgets (SPEC §9.1, decision 7). Enforced only when PRO_ENABLED. */
export const FREE_LIMITS = {
  ownDecks: 3,
  ownNotes: 300,
  /** AI card generations per learning day; cache hits are free (§4.1a). */
  generationsPerDay: 5,
  /** Texts run through «Слова из текста» per learning day (§4.3, §9.1). */
  textsPerDay: 1,
} as const;

export interface LimitCheck {
  allowed: boolean;
  /** Infinity when the limit does not apply (Pro, or PRO_ENABLED=false). */
  limit: number;
  used: number;
}

export interface LimitsPort {
  countOwnDecks(userId: number): Promise<number>;
  countOwnNotes(userId: number): Promise<number>;
  /** `word_generated` events with `cached: false` since the given instant. */
  countGenerationsSince(userId: number, since: Date): Promise<number>;
  /** `text_extracted` events since the given instant — one per text (§4.3). */
  countExtractionsSince(userId: number, since: Date): Promise<number>;
}

/** A paying user: any non-free plan whose `planUntil` has not passed. */
export function isPro(user: Pick<User, "plan" | "planUntil">, now: Date): boolean {
  if (user.plan === "free") return false;
  return user.planUntil === null || user.planUntil.getTime() > now.getTime();
}

const unlimited = (used = 0): LimitCheck => ({
  allowed: true,
  limit: Number.POSITIVE_INFINITY,
  used,
});

export interface Limits {
  canCreateDeck(user: User, now: Date): Promise<LimitCheck>;
  canAddNotes(user: User, count: number, now: Date): Promise<LimitCheck>;
  /** AI generations left in the current learning day (04:00 boundary, §9.1). */
  canGenerate(user: User, now: Date): Promise<LimitCheck>;
  /** Texts left to run through word extraction today (§4.3, §9.1). */
  canExtract(user: User, now: Date): Promise<LimitCheck>;
}

/**
 * All gating goes through here, so flipping `PRO_ENABLED` is the only change
 * needed to start (or stop) enforcing the Free plan.
 */
export function createLimits(port: LimitsPort, options: { proEnabled: boolean }): Limits {
  return {
    async canCreateDeck(user, now) {
      if (!options.proEnabled || isPro(user, now)) return unlimited();
      const used = await port.countOwnDecks(user.id);
      return { allowed: used < FREE_LIMITS.ownDecks, limit: FREE_LIMITS.ownDecks, used };
    },

    async canAddNotes(user, count, now) {
      if (!options.proEnabled || isPro(user, now)) return unlimited();
      const used = await port.countOwnNotes(user.id);
      return { allowed: used + count <= FREE_LIMITS.ownNotes, limit: FREE_LIMITS.ownNotes, used };
    },

    async canGenerate(user, now) {
      if (!options.proEnabled || isPro(user, now)) return unlimited();
      const since = startOfLearningDay(now, user.tz);
      const used = await port.countGenerationsSince(user.id, since);
      return {
        allowed: used < FREE_LIMITS.generationsPerDay,
        limit: FREE_LIMITS.generationsPerDay,
        used,
      };
    },

    async canExtract(user, now) {
      if (!options.proEnabled || isPro(user, now)) return unlimited();
      const since = startOfLearningDay(now, user.tz);
      const used = await port.countExtractionsSince(user.id, since);
      return { allowed: used < FREE_LIMITS.textsPerDay, limit: FREE_LIMITS.textsPerDay, used };
    },
  };
}

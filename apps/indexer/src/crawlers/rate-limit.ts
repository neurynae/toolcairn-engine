import { Octokit } from '@octokit/rest';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:rate-limit' });

// ─── Rate state ───────────────────────────────────────────────────────────────

interface RateState {
  remaining: number;
  resetAt: number; // unix epoch seconds
  limit: number;
}

// ─── Token slot ───────────────────────────────────────────────────────────────

export interface TokenSlot {
  octokit: Octokit;
  core: RateState;
  search: RateState;
  label: string; // 'primary' | 'secondary'
  token: string | undefined;
}

// ─── Slot pool (lazy init) ────────────────────────────────────────────────────

/**
 * Primary rate state — kept as a top-level export for backward compatibility
 * with any code that reads coreRateState directly.
 * After getSlots() is called, this object IS slots[0].core (same reference).
 */
export const coreRateState: RateState = { remaining: 5000, resetAt: 0, limit: 5000 };
export const searchRateState: RateState = { remaining: 30, resetAt: 0, limit: 30 };

let _slots: TokenSlot[] | undefined;

/**
 * Lazily initialize the token pool from environment variables.
 * Always includes the primary GITHUB_TOKEN.
 * Adds a secondary slot when GITHUB_TOKEN_2 is set and non-empty.
 * Falls back gracefully to a single-slot pool if the secondary token is absent.
 */
export function getSlots(): TokenSlot[] {
  if (_slots) return _slots;

  // Primary slot — reuses the backward-compat coreRateState / searchRateState objects
  const primaryToken = process.env.GITHUB_TOKEN || undefined;
  const slots: TokenSlot[] = [
    {
      octokit: new Octokit({ auth: primaryToken }),
      core: coreRateState,
      search: searchRateState,
      label: 'primary',
      token: primaryToken,
    },
  ];

  // Secondary slot — optional, zero-scope token from a different GitHub account
  const secondaryToken = process.env.GITHUB_TOKEN_2 || undefined;
  if (secondaryToken) {
    slots.push({
      octokit: new Octokit({ auth: secondaryToken }),
      core: { remaining: 5000, resetAt: 0, limit: 5000 },
      search: { remaining: 30, resetAt: 0, limit: 30 },
      label: 'secondary',
      token: secondaryToken,
    });
    logger.info('GitHub token pool: 2 tokens active (10k core req/hour combined)');
  }

  _slots = slots;
  return _slots;
}

// ─── Best-slot selectors ─────────────────────────────────────────────────────

/** Pick the slot with the most remaining Core API quota. */
export function getBestCoreSlot(): TokenSlot {
  return getSlots().reduce((best, curr) =>
    curr.core.remaining > best.core.remaining ? curr : best,
  );
}

/** Pick the slot with the most remaining Search API quota. */
export function getBestSearchSlot(): TokenSlot {
  return getSlots().reduce((best, curr) =>
    curr.search.remaining > best.search.remaining ? curr : best,
  );
}

// ─── State updaters ──────────────────────────────────────────────────────────

/** Update a specific slot's rate state from response headers. */
export function updateSlotFromHeaders(
  slot: TokenSlot,
  type: 'core' | 'search',
  headers: Record<string, string | undefined>,
): void {
  const state = slot[type];
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  const limit = headers['x-ratelimit-limit'];
  if (remaining !== undefined) state.remaining = Number(remaining);
  if (reset !== undefined) state.resetAt = Number(reset);
  if (limit !== undefined) state.limit = Number(limit);
}

/** Backward-compat: update primary slot's core state. */
export function updateCoreRateState(headers: Record<string, string | undefined>): void {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  updateSlotFromHeaders(getSlots()[0]!, 'core', headers);
}

/** Backward-compat: update primary slot's search state. */
export function updateSearchRateState(headers: Record<string, string | undefined>): void {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  updateSlotFromHeaders(getSlots()[0]!, 'search', headers);
}

// ─── Startup refresh ─────────────────────────────────────────────────────────

/**
 * Refresh rate limits for ALL token slots from the GitHub API on startup.
 * Non-fatal per slot — a failed refresh just leaves the defaults in place.
 */
export async function refreshRateLimitsFromGitHub(): Promise<void> {
  const slots = getSlots();
  for (const slot of slots) {
    await refreshSlotRateLimit(slot);
  }
}

async function refreshSlotRateLimit(slot: TokenSlot): Promise<void> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (slot.token) headers.Authorization = `Bearer ${slot.token}`;

  try {
    const res = await fetch('https://api.github.com/rate_limit', { headers });
    if (!res.ok) {
      logger.warn(
        { status: res.status, label: slot.label },
        'rate_limit fetch failed — using defaults',
      );
      return;
    }

    const body = (await res.json()) as {
      resources: {
        core: { remaining: number; limit: number; reset: number };
        search: { remaining: number; limit: number; reset: number };
      };
    };

    const { core, search } = body.resources;
    slot.core.remaining = core.remaining;
    slot.core.resetAt = core.reset;
    slot.core.limit = core.limit;
    slot.search.remaining = search.remaining;
    slot.search.resetAt = search.reset;
    slot.search.limit = search.limit;

    logger.info(
      {
        label: slot.label,
        core: `${core.remaining}/${core.limit}`,
        search: `${search.remaining}/${search.limit}`,
      },
      'Rate limits refreshed',
    );
  } catch (e) {
    logger.warn({ err: e, label: slot.label }, 'Failed to refresh rate limits — using defaults');
  }
}

// ─── Low water marks ─────────────────────────────────────────────────────────

export const CORE_LOW_WATER_MARK = 100;
export const CORE_SLOW_WATER_MARK = 500;
export const SEARCH_LOW_WATER_MARK = 3;

// ─── Sleep helpers ────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the soonest-resetting core slot becomes available.
 * With two tokens, this is typically much shorter than a full hour wait.
 */
export async function sleepUntilCoreReset(): Promise<void> {
  const slots = getSlots();
  // Wait for the slot that resets soonest (earliest resetAt)
  const soonest = slots.reduce((a, b) => (a.core.resetAt < b.core.resetAt ? a : b));
  const nowSec = Date.now() / 1000;
  const waitSec = Math.max(0, soonest.core.resetAt - nowSec) + 5;
  logger.warn(
    {
      waitSec: Math.round(waitSec),
      label: soonest.label,
      slots: slots.length,
      totalRemaining: slots.reduce((s, sl) => s + sl.core.remaining, 0),
    },
    'Core rate limit critical — sleeping until earliest reset',
  );
  await sleep(waitSec * 1000);
}

export async function sleepUntilSearchReset(): Promise<void> {
  const slots = getSlots();
  const soonest = slots.reduce((a, b) => (a.search.resetAt < b.search.resetAt ? a : b));
  const nowSec = Date.now() / 1000;
  const waitSec = Math.max(0, soonest.search.resetAt - nowSec) + 2;
  logger.warn(
    { waitSec: Math.round(waitSec), label: soonest.label },
    'Search rate limit low — sleeping until earliest reset',
  );
  await sleep(waitSec * 1000);
}

// ─── Dynamic pacing ───────────────────────────────────────────────────────────

export function recommendedCrawlDelay(): number {
  const { remaining } = getBestCoreSlot().core;
  if (remaining > CORE_SLOW_WATER_MARK) return 0;
  if (remaining > CORE_LOW_WATER_MARK) return 1_000;
  return 3_000;
}

export async function corePreFlight(): Promise<void> {
  const best = getBestCoreSlot();
  if (best.core.remaining < CORE_LOW_WATER_MARK && best.core.resetAt > 0) {
    await sleepUntilCoreReset();
  }
  const delay = recommendedCrawlDelay();
  if (delay > 0) await sleep(delay);
}

export async function searchPreFlight(): Promise<void> {
  const best = getBestSearchSlot();
  if (best.search.remaining < SEARCH_LOW_WATER_MARK && best.search.resetAt > 0) {
    await sleepUntilSearchReset();
  }
}

// ─── Budget estimation (uses combined quota across all tokens) ────────────────

const CORE_CALLS_PER_TOOL = 5;

export function hasBudgetFor(toolCount: number): boolean {
  const totalRemaining = getSlots().reduce((sum, s) => sum + s.core.remaining, 0);
  return totalRemaining > toolCount * CORE_CALLS_PER_TOOL + CORE_LOW_WATER_MARK;
}

export function maxToolsWithCurrentBudget(): number {
  const totalRemaining = getSlots().reduce((sum, s) => sum + s.core.remaining, 0);
  const usable = Math.max(0, totalRemaining - CORE_LOW_WATER_MARK);
  return Math.floor(usable / CORE_CALLS_PER_TOOL);
}

export function getRateLimitStatus(): {
  core: { remaining: number; limit: number; resetAt: number; pct: number };
  search: { remaining: number; limit: number; resetAt: number; pct: number };
  maxIndexableTools: number;
  tokens: number;
} {
  const slots = getSlots();
  const totalCore = slots.reduce((s, sl) => s + sl.core.remaining, 0);
  const totalCoreLimit = slots.reduce((s, sl) => s + sl.core.limit, 0);
  const bestCore = getBestCoreSlot().core;
  const bestSearch = getBestSearchSlot().search;

  return {
    core: {
      remaining: totalCore,
      limit: totalCoreLimit,
      resetAt: bestCore.resetAt,
      pct: Math.round((totalCore / Math.max(totalCoreLimit, 1)) * 100),
    },
    search: {
      remaining: bestSearch.remaining,
      limit: bestSearch.limit,
      resetAt: bestSearch.resetAt,
      pct: Math.round((bestSearch.remaining / Math.max(bestSearch.limit, 1)) * 100),
    },
    maxIndexableTools: maxToolsWithCurrentBudget(),
    tokens: slots.length,
  };
}

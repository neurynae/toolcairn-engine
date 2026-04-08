import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:rate-limit' });

// ─── Core API state ───────────────────────────────────────────────────────────

interface RateState {
  remaining: number;
  resetAt: number; // unix epoch seconds
  limit: number; // total allowed per window (usually 5000)
}

export const coreRateState: RateState = { remaining: 5000, resetAt: 0, limit: 5000 };
export const searchRateState: RateState = { remaining: 30, resetAt: 0, limit: 30 };

// ─── LOW water marks ─────────────────────────────────────────────────────────

/** Stop and wait for reset when Core API remaining drops below this. */
export const CORE_LOW_WATER_MARK = 100;
/** Slow down (add delay) when Core API remaining drops below this. */
export const CORE_SLOW_WATER_MARK = 500;
/** Stop discovery search when Search API remaining drops below this. */
export const SEARCH_LOW_WATER_MARK = 3;

// ─── State updaters ──────────────────────────────────────────────────────────

export function updateCoreRateState(headers: Record<string, string | undefined>): void {
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  const limit = headers['x-ratelimit-limit'];
  if (remaining !== undefined) coreRateState.remaining = Number(remaining);
  if (reset !== undefined) coreRateState.resetAt = Number(reset);
  if (limit !== undefined) coreRateState.limit = Number(limit);
}

export function updateSearchRateState(headers: Record<string, string | undefined>): void {
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  const limit = headers['x-ratelimit-limit'];
  if (remaining !== undefined) searchRateState.remaining = Number(remaining);
  if (reset !== undefined) searchRateState.resetAt = Number(reset);
  if (limit !== undefined) searchRateState.limit = Number(limit);
}

// ─── Startup refresh ─────────────────────────────────────────────────────────

/**
 * Fetch the ACTUAL remaining quota from GitHub on indexer startup.
 *
 * Without this, coreRateState / searchRateState start at their theoretical
 * maximums (5000 / 30) even if the previous indexer run had already consumed
 * significant quota. The first 403/429 would eventually correct the state, but
 * by then we may have over-paced or made unnecessary requests.
 *
 * Calls GET /rate_limit (which does NOT consume Core quota) and writes the real
 * remaining + resetAt into coreRateState and searchRateState before any crawl
 * work begins.
 *
 * Non-fatal: if the request fails (no token, network issue) we log a warning
 * and continue with the defaults — the existing self-correction via response
 * headers still applies.
 */
export async function refreshRateLimitsFromGitHub(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('https://api.github.com/rate_limit', { headers });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'rate_limit fetch failed — using default state');
      return;
    }

    const body = (await res.json()) as {
      resources: {
        core: { remaining: number; limit: number; reset: number };
        search: { remaining: number; limit: number; reset: number };
      };
    };

    const core = body.resources.core;
    const search = body.resources.search;

    coreRateState.remaining = core.remaining;
    coreRateState.resetAt = core.reset;
    coreRateState.limit = core.limit;

    searchRateState.remaining = search.remaining;
    searchRateState.resetAt = search.reset;
    searchRateState.limit = search.limit;

    logger.info(
      {
        core: `${core.remaining}/${core.limit}`,
        search: `${search.remaining}/${search.limit}`,
      },
      'GitHub rate limits refreshed from API',
    );
  } catch (e) {
    logger.warn({ err: e }, 'Failed to refresh rate limits from GitHub — using defaults');
  }
}

// ─── Sleep helpers ────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function sleepUntilCoreReset(): Promise<void> {
  const nowSec = Date.now() / 1000;
  const waitSec = Math.max(0, coreRateState.resetAt - nowSec) + 5; // +5s safety buffer
  logger.warn(
    { remaining: coreRateState.remaining, waitSec: Math.round(waitSec) },
    'Core rate limit critical — sleeping until reset',
  );
  await sleep(waitSec * 1000);
}

export async function sleepUntilSearchReset(): Promise<void> {
  const nowSec = Date.now() / 1000;
  const waitSec = Math.max(0, searchRateState.resetAt - nowSec) + 2;
  logger.warn(
    { remaining: searchRateState.remaining, waitSec: Math.round(waitSec) },
    'Search rate limit low — sleeping until reset',
  );
  await sleep(waitSec * 1000);
}

// ─── Dynamic pacing ───────────────────────────────────────────────────────────

/**
 * Return a recommended delay (ms) between Core API crawl operations based on
 * current rate-limit remaining. This maximizes throughput safely:
 * - Full speed when quota is high
 * - Gradual slowdown as quota decreases
 * - Hard stop at CORE_LOW_WATER_MARK
 */
export function recommendedCrawlDelay(): number {
  const { remaining } = coreRateState;

  if (remaining > CORE_SLOW_WATER_MARK) return 0; // plenty left — full speed
  if (remaining > CORE_LOW_WATER_MARK) return 1_000; // 500–1000: add 1s gap
  return 3_000; // 100–500: add 3s gap
}

/**
 * Pre-flight check for Core API. Waits if quota is critical.
 * Should be called before every Core API request.
 */
export async function corePreFlight(): Promise<void> {
  if (coreRateState.remaining < CORE_LOW_WATER_MARK && coreRateState.resetAt > 0) {
    await sleepUntilCoreReset();
  }
  // Apply dynamic pacing delay
  const delay = recommendedCrawlDelay();
  if (delay > 0) await sleep(delay);
}

/**
 * Pre-flight check for Search API. Waits if search quota is critical.
 */
export async function searchPreFlight(): Promise<void> {
  if (searchRateState.remaining < SEARCH_LOW_WATER_MARK && searchRateState.resetAt > 0) {
    await sleepUntilSearchReset();
  }
}

// ─── Budget estimation ────────────────────────────────────────────────────────

/** Approximate Core API calls per full tool crawl (repo + languages + topics + contents + package.json). */
const CORE_CALLS_PER_TOOL = 5;

/**
 * Estimate whether there is enough Core API budget to index N tools.
 * Returns true if safe to proceed, false if not enough budget remains.
 */
export function hasBudgetFor(toolCount: number): boolean {
  const needed = toolCount * CORE_CALLS_PER_TOOL;
  return coreRateState.remaining > needed + CORE_LOW_WATER_MARK;
}

/**
 * How many tools can safely be indexed with the current remaining quota.
 */
export function maxToolsWithCurrentBudget(): number {
  const usable = Math.max(0, coreRateState.remaining - CORE_LOW_WATER_MARK);
  return Math.floor(usable / CORE_CALLS_PER_TOOL);
}

/**
 * Full rate limit status — exposed to admin monitoring and cron decisions.
 */
export function getRateLimitStatus(): {
  core: { remaining: number; limit: number; resetAt: number; pct: number };
  search: { remaining: number; limit: number; resetAt: number; pct: number };
  maxIndexableTools: number;
} {
  return {
    core: {
      remaining: coreRateState.remaining,
      limit: coreRateState.limit,
      resetAt: coreRateState.resetAt,
      pct: Math.round((coreRateState.remaining / Math.max(coreRateState.limit, 1)) * 100),
    },
    search: {
      remaining: searchRateState.remaining,
      limit: searchRateState.limit,
      resetAt: searchRateState.resetAt,
      pct: Math.round((searchRateState.remaining / Math.max(searchRateState.limit, 1)) * 100),
    },
    maxIndexableTools: maxToolsWithCurrentBudget(),
  };
}

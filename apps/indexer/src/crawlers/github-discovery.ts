/**
 * GitHub Discovery Crawler — finds new repositories to index.
 *
 * Uses GitHub Search API to discover repos by:
 * - Topics (e.g., ai, mcp, vector-db)
 * - Stars threshold (min stars to filter noise)
 * - Last pushed date (recent activity)
 *
 * Rate-limit strategy (all three approaches):
 * 1. Authenticated requests (30/min vs 10/min unauthenticated)
 * 2. Distributed across topics (spreads load)
 * 3. Results cache (in-memory) for same topic searches
 */

import { createLogger } from '@toolcairn/errors';
import { setProgress } from '../progress.js';
import {
  getBestSearchSlot,
  getRateLimitStatus,
  refreshRateLimitsFromGitHub,
  searchPreFlight,
  sleep,
  updateSlotFromHeaders,
} from './rate-limit.js';

export { getRateLimitStatus, refreshRateLimitsFromGitHub };

const logger = createLogger({ name: '@toolcairn/indexer:github-discovery' });

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface DiscoveredRepo {
  owner: string;
  repo: string;
  fullName: string;
  stars: number;
  forks: number;
  description: string | null;
  language: string | null;
  topics: string[];
  lastPushed: Date;
  license: string | null;
}

// ─── Discovery logic ─────────────────────────────────────────────────────────

// Octokit is provided by the token pool in rate-limit.ts — no local singleton needed.

/** Sort strategies GitHub Search supports for repositories. */
export type SortMode = 'stars' | 'updated' | 'help-wanted-issues';

/** Rotate sort mode by day so successive scheduler runs hit different slices. */
export function pickSortModeForToday(): SortMode {
  const day = Math.floor(Date.now() / 86_400_000);
  const modes: SortMode[] = ['stars', 'updated', 'help-wanted-issues'];
  // biome-ignore lint/style/noNonNullAssertion: modulo always in range
  return modes[day % modes.length]!;
}

/**
 * Languages to probe alongside topic-based discovery. Covers tools that don't
 * tag GitHub topics but are still well-starred within their ecosystem.
 */
export const DISCOVERY_LANGUAGES: string[] = [
  'JavaScript',
  'TypeScript',
  'Python',
  'Rust',
  'Go',
  'Java',
  'Kotlin',
  'Swift',
  'C++',
  'C',
  'Ruby',
  'PHP',
  'C#',
  'Scala',
  'Elixir',
  'Dart',
  'Haskell',
  'Lua',
];

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // biome-ignore lint/style/noNonNullAssertion: ISO always has a date segment
  return d.toISOString().split('T')[0]!;
}

/**
 * 30-day pushed-date windows walking back from today. Used with `sort: 'updated'`
 * to surface each month's most-active repos instead of the same top-all-time set.
 */
export function buildPushedWindows(
  days: number,
  stepDays = 30,
): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  for (let offset = 0; offset < days; offset += stepDays) {
    windows.push({ from: isoDate(offset + stepDays), to: isoDate(offset) });
  }
  return windows;
}

interface SearchOptions {
  sort: SortMode;
  pages: number;
  /** Optional inclusive pushed-at window (YYYY-MM-DD). Takes precedence over pushedWithinDays. */
  pushedFrom?: string;
  pushedTo?: string;
}

/**
 * Execute a single GitHub Search query with paginated fetch.
 * Returns up to `pages * 100` repos matching the query, deduplicated by full_name.
 */
async function runSearchQuery(
  query: string,
  options: SearchOptions,
  label: string,
): Promise<DiscoveredRepo[]> {
  const { sort, pages } = options;
  const repos: DiscoveredRepo[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= pages; page++) {
    await searchPreFlight();
    const slot = getBestSearchSlot();
    try {
      const response = await slot.octokit.rest.search.repos({
        q: query,
        sort,
        order: 'desc',
        per_page: 100,
        page,
      });
      updateSlotFromHeaders(slot, 'search', response.headers as Record<string, string | undefined>);

      const items = response.data.items ?? [];
      for (const item of items) {
        const isPersonalRepo = item.owner?.type === 'User';
        const stars = item.stargazers_count ?? 0;
        // Keep org repos at any starcount; skip personal repos under 1000★
        if (isPersonalRepo && stars < 1000) continue;
        const fullName = item.full_name ?? '';
        if (!fullName || seen.has(fullName)) continue;
        seen.add(fullName);
        repos.push({
          owner: item.owner?.login ?? '',
          repo: item.name ?? '',
          fullName,
          stars,
          forks: item.forks_count ?? 0,
          description: item.description,
          language: item.language,
          topics: item.topics ?? [],
          lastPushed: new Date(item.pushed_at ?? ''),
          license: item.license?.spdx_id ?? null,
        });
      }

      // No more pages if the API returned fewer than a full page.
      if (items.length < 100) break;
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { headers?: Record<string, string> } };
      const status = e.status ?? 0;
      const respHeaders = e.response?.headers ?? {};
      updateSlotFromHeaders(slot, 'search', respHeaders as Record<string, string | undefined>);
      if ((status === 403 && respHeaders['x-ratelimit-remaining'] === '0') || status === 429) {
        logger.warn({ label, page }, 'Search rate limited — sleeping to reset');
        const nowSec = Date.now() / 1000;
        const reset = Number(respHeaders['x-ratelimit-reset'] ?? 0);
        const waitSec = Math.max(0, reset - nowSec) + 2;
        await sleep(waitSec * 1000);
        break; // give up on this query; next scheduler run will retry
      }
      logger.error({ label, page, err }, 'Search query failed — aborting this query');
      break;
    }
  }

  logger.info(
    { label, found: repos.length, remaining: getRateLimitStatus().search.remaining },
    'Search query complete',
  );
  return repos;
}

/**
 * Search GitHub for repositories matching a topic criterion.
 *
 * @param topic - GitHub topic to search for
 * @param minStars - Minimum star count
 * @param pushedWithinDays - Only repos pushed within this many days
 * @param pages - How many pages (of 100) to fetch. Default 3 → up to 300 results.
 * @param sort - Sort strategy
 */
export async function searchReposByTopic(
  topic: string,
  minStars = 100,
  pushedWithinDays = 90,
  pages = 3,
  sort: SortMode = 'stars',
): Promise<DiscoveredRepo[]> {
  const query = `topic:${topic} stars:>${minStars} pushed:>${isoDate(pushedWithinDays)}`;
  return runSearchQuery(query, { sort, pages }, `topic:${topic}`);
}

/**
 * Walk backward in 30-day pushed-at windows for a topic, one page per window.
 * Used with `sort: 'updated'` to surface each month's most-active repos.
 */
export async function searchReposByTopicWindowed(
  topic: string,
  minStars: number,
  days: number,
): Promise<DiscoveredRepo[]> {
  const all = new Map<string, DiscoveredRepo>();
  for (const w of buildPushedWindows(days, 30)) {
    const query = `topic:${topic} stars:>${minStars} pushed:${w.from}..${w.to}`;
    const batch = await runSearchQuery(
      query,
      { sort: 'updated', pages: 1 },
      `topic:${topic}@${w.from}..${w.to}`,
    );
    for (const repo of batch) {
      const prev = all.get(repo.fullName);
      if (!prev || prev.stars < repo.stars) all.set(repo.fullName, repo);
    }
    await sleep(300);
  }
  return Array.from(all.values());
}

/**
 * Search GitHub for repositories by primary language (catches tools without
 * GitHub topics — ~30% of the long tail). Always paginated.
 */
export async function searchReposByLanguage(
  language: string,
  minStars: number,
  pushedWithinDays: number,
  pages = 3,
  sort: SortMode = 'stars',
): Promise<DiscoveredRepo[]> {
  // Quote multi-word/punctuated languages ("C++", "C#")
  const langQ = /[^\w-]/.test(language) ? `"${language}"` : language;
  const query = `language:${langQ} stars:>${minStars} pushed:>${isoDate(pushedWithinDays)}`;
  return runSearchQuery(query, { sort, pages }, `lang:${language}`);
}

export interface MultiStrategyOptions {
  topics: string[];
  languages?: string[];
  minStars: number;
  pushedWithinDays: number;
  pagesPerTopic?: number;
  /** Override — otherwise pickSortModeForToday() is used. */
  sortMode?: SortMode;
}

/**
 * Full-expansion discovery across multiple strategies:
 * 1. Paginated topic search (3 pages by default)
 * 2. Sort rotation: 'stars' / 'updated' / 'help-wanted-issues' per day
 * 3. When sort = 'updated', walk 30-day pushed-at windows instead of a flat
 *    top-100 slice — surfaces recent arrivals across the whole window
 * 4. Language-based search over a curated list to pick up topic-less repos
 */
export async function discoverReposAcrossTopics(
  topicsOrOptions: string[] | MultiStrategyOptions,
  minStarsArg = 100,
  pushedWithinDaysArg = 90,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ignored = 50,
): Promise<DiscoveredRepo[]> {
  // Back-compat shim: old callers passed (topics[], minStars, days, maxPerTopic).
  // New callers pass a single MultiStrategyOptions object.
  const opts: MultiStrategyOptions = Array.isArray(topicsOrOptions)
    ? {
        topics: topicsOrOptions,
        minStars: minStarsArg,
        pushedWithinDays: pushedWithinDaysArg,
      }
    : topicsOrOptions;

  const {
    topics,
    languages = DISCOVERY_LANGUAGES,
    minStars,
    pushedWithinDays,
    pagesPerTopic = 3,
  } = opts;
  const sortMode: SortMode = opts.sortMode ?? pickSortModeForToday();
  const allRepos = new Map<string, DiscoveredRepo>();

  logger.info(
    {
      topicCount: topics.length,
      languageCount: languages.length,
      minStars,
      pushedWithinDays,
      pagesPerTopic,
      sortMode,
    },
    'Discovery expansion starting',
  );

  // ── Topic sweep ───────────────────────────────────────────────────────────
  for (const [i, topic] of topics.entries()) {
    await setProgress(
      `Searching topic "${topic}" sort=${sortMode} (${i + 1}/${topics.length})`,
      `${allRepos.size} unique repos found so far`,
      { topicIdx: i + 1, totalTopics: topics.length, reposSoFar: allRepos.size },
    );

    try {
      const batch =
        sortMode === 'updated'
          ? await searchReposByTopicWindowed(topic, minStars, pushedWithinDays)
          : await searchReposByTopic(topic, minStars, pushedWithinDays, pagesPerTopic, sortMode);

      for (const repo of batch) {
        const prev = allRepos.get(repo.fullName);
        if (!prev || prev.stars < repo.stars) allRepos.set(repo.fullName, repo);
      }
      logger.debug({ topic, found: batch.length, totalUnique: allRepos.size }, 'Topic done');
      await sleep(300);
    } catch (err) {
      logger.error({ topic, err }, 'Topic search failed — continuing');
    }
  }

  // ── Language sweep (always on — surfaces topic-less repos) ────────────────
  for (const [i, language] of languages.entries()) {
    await setProgress(
      `Searching language "${language}" sort=${sortMode} (${i + 1}/${languages.length})`,
      `${allRepos.size} unique repos found so far`,
      { langIdx: i + 1, totalLangs: languages.length, reposSoFar: allRepos.size },
    );
    try {
      const batch = await searchReposByLanguage(
        language,
        minStars,
        pushedWithinDays,
        pagesPerTopic,
        sortMode,
      );
      for (const repo of batch) {
        const prev = allRepos.get(repo.fullName);
        if (!prev || prev.stars < repo.stars) allRepos.set(repo.fullName, repo);
      }
      logger.debug({ language, found: batch.length, totalUnique: allRepos.size }, 'Lang done');
      await sleep(300);
    } catch (err) {
      logger.error({ language, err }, 'Language search failed — continuing');
    }
  }

  logger.info(
    {
      totalUnique: allRepos.size,
      topics: topics.length,
      languages: languages.length,
      sortMode,
    },
    'Multi-strategy discovery complete',
  );

  return Array.from(allRepos.values()).sort((a, b) => b.stars - a.stars);
}

// Rate limit status is now exported from rate-limit.ts via getRateLimitStatus()

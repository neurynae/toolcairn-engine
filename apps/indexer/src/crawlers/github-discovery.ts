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

import { Octokit } from '@octokit/rest';
import { config } from '@toolcairn/config';
import pino from 'pino';
import { setProgress } from '../progress.js';
import {
  getRateLimitStatus,
  refreshRateLimitsFromGitHub,
  searchPreFlight,
  sleep,
  updateSearchRateState,
} from './rate-limit.js';

export { getRateLimitStatus, refreshRateLimitsFromGitHub };

const logger = pino({ name: '@toolcairn/indexer:github-discovery' });

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

// ─── Octokit singleton ────────────────────────────────────────────────────────

let _octokit: Octokit | undefined;

function getOctokit(): Octokit {
  if (!_octokit) {
    _octokit = new Octokit({ auth: config.GITHUB_TOKEN || undefined });
  }
  return _octokit;
}

// ─── Discovery logic ─────────────────────────────────────────────────────────

// No local rate state — all rate tracking is in rate-limit.ts (shared with github.ts)

/**
 * Search GitHub for repositories matching criteria.
 *
 * @param topic - GitHub topic to search for
 * @param minStars - Minimum star count
 * @param pushedWithinDays - Only repos pushed within this many days
 * @param maxResults - Maximum results to return (GitHub caps at 1000, we default lower)
 */
export async function searchReposByTopic(
  topic: string,
  minStars = 100,
  pushedWithinDays = 90,
  maxResults = 50,
): Promise<DiscoveredRepo[]> {
  const octokit = getOctokit();

  // Calculate date cutoff
  const dateCutoff = new Date();
  dateCutoff.setDate(dateCutoff.getDate() - pushedWithinDays);
  const dateString = dateCutoff.toISOString().split('T')[0];

  // Build search query
  const query = `topic:${topic} stars:>${minStars} pushed:>${dateString}`;

  logger.info({ topic, minStars, pushedWithinDays, maxResults, query }, 'Searching GitHub');

  // Pre-flight: wait if search quota is critically low (Search API: 30 req/min)
  await searchPreFlight();

  try {
    const response = await octokit.rest.search.repos({
      q: query,
      sort: 'stars',
      order: 'desc',
      per_page: Math.min(maxResults, 100),
      page: 1,
    });

    updateSearchRateState(response.headers as Record<string, string | undefined>);

    const repos: DiscoveredRepo[] = [];

    for (const item of response.data.items ?? []) {
      // Skip personal repos with fewer than 1000 stars — org repos always pass
      const isPersonalRepo = item.owner?.type === 'User';
      const stars = item.stargazers_count ?? 0;
      if (isPersonalRepo && stars < 1000) continue;

      repos.push({
        owner: item.owner?.login ?? '',
        repo: item.name ?? '',
        fullName: item.full_name ?? '',
        stars,
        forks: item.forks_count ?? 0,
        description: item.description,
        language: item.language,
        topics: item.topics ?? [],
        lastPushed: new Date(item.pushed_at ?? ''),
        license: item.license?.spdx_id ?? null,
      });
    }

    logger.info(
      { topic, found: repos.length, remaining: getRateLimitStatus().search.remaining },
      'Discovery search complete',
    );

    return repos;
  } catch (err: unknown) {
    const e = err as { status?: number; response?: { headers?: Record<string, string> } };
    const status = e.status ?? 0;
    const respHeaders = e.response?.headers ?? {};

    updateSearchRateState(respHeaders as Record<string, string | undefined>);

    // Search API rate limit — sleep until reset window and return empty (retry on next cron)
    if ((status === 403 && respHeaders['x-ratelimit-remaining'] === '0') || status === 429) {
      logger.warn({ topic }, 'Search rate limited — returning empty for this topic');
      const nowSec = Date.now() / 1000;
      const reset = Number(respHeaders['x-ratelimit-reset'] ?? 0);
      const waitSec = Math.max(0, reset - nowSec) + 2;
      await sleep(waitSec * 1000);
      return [];
    }

    // Handle other errors
    logger.error({ topic, err }, 'Discovery search failed');
    throw err;
  }
}

/**
 * Search multiple topics and deduplicate results.
 * Distributes requests across topics to avoid rate limits.
 *
 * @param topics - Array of topics to search
 * @param minStars - Minimum star threshold
 * @param pushedWithinDays - How recent to consider
 * @param maxPerTopic - Max results per topic
 */
export async function discoverReposAcrossTopics(
  topics: string[],
  minStars = 100,
  pushedWithinDays = 90,
  maxPerTopic = 50,
): Promise<DiscoveredRepo[]> {
  const allRepos = new Map<string, DiscoveredRepo>();

  for (const [i, topic] of topics.entries()) {
    // Pre-flight before each topic (Search API: 30/min limit)
    await searchPreFlight();

    await setProgress(
      `Searching GitHub: topic "${topic}" (${i + 1}/${topics.length})`,
      `${allRepos.size} unique repos found so far`,
      { topicIdx: i + 1, totalTopics: topics.length, reposSoFar: allRepos.size },
    );

    try {
      const repos = await searchReposByTopic(topic, minStars, pushedWithinDays, maxPerTopic);

      for (const repo of repos) {
        // Deduplicate by full name - keep the one with more stars
        const existing = allRepos.get(repo.fullName);
        if (!existing || existing.stars < repo.stars) {
          allRepos.set(repo.fullName, repo);
        }
      }

      logger.debug({ topic, found: repos.length, totalUnique: allRepos.size }, 'Topic search done');
      // Small delay between topics to spread load
      await sleep(500);
    } catch (err) {
      logger.error({ topic, err }, 'Failed to search topic — continuing');
      // Continue to next topic
    }
  }

  logger.info(
    { totalUnique: allRepos.size, topics: topics.length },
    'Multi-topic discovery complete',
  );

  return Array.from(allRepos.values()).sort((a, b) => b.stars - a.stars);
}

// Rate limit status is now exported from rate-limit.ts via getRateLimitStatus()

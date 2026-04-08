/**
 * Bulk Indexer — reaches 10,000 unique indexed tools.
 *
 * Strategy:
 *   1. DISCOVER — multi-page GitHub search (topics + keywords) with low star threshold
 *   2. ENQUEUE  — add undiscovered repos to PostgreSQL as 'pending', skip known ones
 *   3. INDEX    — process the queue via handleIndexJob (rate-limited)
 *   4. RETRY    — every 1k new tools: retry failed (≤5 attempts) + un-stick pending (>2h)
 *   5. LOOP     — repeat until TARGET_COUNT indexed tools reached
 *
 * Usage:
 *   pnpm tsx src/bulk-index-10k.ts
 *
 * Env vars:
 *   TARGET_COUNT=10000       How many indexed tools to reach (default 10000)
 *   MIN_STARS=10             Minimum GitHub stars (default 10)
 *   PAGES_PER_TOPIC=5        Pages per topic search, 30 results/page (default 5)
 *   CONCURRENCY=3            Parallel index jobs (default 3)
 *   BATCH_SIZE=50            Tools processed per batch before a progress check
 *   PUSHED_WITHIN_DAYS=365   Recency filter (default 365 — broader than default 90)
 *   DRY_RUN=1                Discover and enqueue only, don't index
 */

import { Octokit } from '@octokit/rest';
import { config } from '@toolcairn/config';
import { PrismaClient } from '@toolcairn/db';
import { enqueueIndexJob } from '@toolcairn/queue';
import pino from 'pino';
import {
  corePreFlight,
  getRateLimitStatus,
  refreshRateLimitsFromGitHub,
  searchPreFlight,
  sleep,
  updateSearchRateState,
} from './crawlers/rate-limit.js';
import { handleIndexJob } from './queue-consumers/index-consumer.js';

const logger = pino({ name: '@toolcairn/indexer:bulk-10k', level: 'info' });

// ── Configuration ─────────────────────────────────────────────────────────────

const TARGET_COUNT = Number(process.env.TARGET_COUNT ?? 10_000);
const MIN_STARS = Number(process.env.MIN_STARS ?? 10);
const PAGES_PER_TOPIC = Number(process.env.PAGES_PER_TOPIC ?? 5);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);
const PUSHED_DAYS = Number(process.env.PUSHED_WITHIN_DAYS ?? 365);
const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_RETRIES = 5;
const STUCK_HOURS = 2; // pending jobs older than this are re-queued
const RETRY_INTERVAL = 1_000; // retry failed every N newly indexed tools

// ── Additional keyword queries beyond DEFAULT_DISCOVERY_TOPICS ────────────────
// These catch tools that don't use GitHub topic tags but are highly relevant.
const KEYWORD_QUERIES: string[] = [
  'mcp server',
  'model context protocol',
  'llm agent framework',
  'ai agent sdk',
  'vector database client',
  'embedding library',
  'langchain compatible',
  'openai sdk wrapper',
  'claude anthropic sdk',
  'rag framework',
  'ai observability',
  'llm evaluation',
  'prompt engineering',
  'ai workflow',
  'tool use function calling',
  'semantic search library',
  'graph rag',
  'multimodal ai',
  'ai code generation',
  'developer tools sdk',
  'api client generator',
  'typescript orm',
  'database migration',
  'job queue worker',
  'rate limiting middleware',
  'oauth authentication',
  'websocket server',
  'grpc framework',
  'graphql server',
  'rest api framework',
];

// ── GitHub client ──────────────────────────────────────────────────────────────

let _octokit: Octokit | undefined;
function getOctokit() {
  if (!_octokit) _octokit = new Octokit({ auth: config.GITHUB_TOKEN || undefined });
  return _octokit;
}

// ── Search helpers ─────────────────────────────────────────────────────────────

interface RepoHit {
  fullName: string;
  stars: number;
}

async function searchPage(query: string, page: number): Promise<RepoHit[]> {
  await searchPreFlight();
  const octokit = getOctokit();
  try {
    const res = await octokit.rest.search.repos({
      q: query,
      sort: 'stars',
      order: 'desc',
      per_page: 30,
      page,
    });
    updateSearchRateState(res.headers as Record<string, string | undefined>);
    return (res.data.items ?? []).map((r) => ({
      fullName: r.full_name ?? '',
      stars: r.stargazers_count ?? 0,
    }));
  } catch (err: unknown) {
    const e = err as { status?: number; response?: { headers?: Record<string, string> } };
    updateSearchRateState((e.response?.headers ?? {}) as Record<string, string | undefined>);
    if (e.status === 403 || e.status === 429) {
      const reset = Number(e.response?.headers?.['x-ratelimit-reset'] ?? 0);
      const waitSec = Math.max(10, reset - Date.now() / 1000) + 2;
      logger.warn({ query, waitSec }, 'Search rate limited — waiting');
      await sleep(waitSec * 1000);
      return [];
    }
    logger.warn({ query, page, err: (err as Error).message }, 'Search page failed — skipping');
    return [];
  }
}

/** Search multiple pages for a topic query. Returns unique fullNames. */
async function discoverTopic(topic: string, pages: number): Promise<string[]> {
  const date = new Date();
  date.setDate(date.getDate() - PUSHED_DAYS);
  const dateStr = date.toISOString().split('T')[0];
  const query = `topic:${topic} stars:>${MIN_STARS} pushed:>${dateStr}`;
  const found = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    const hits = await searchPage(query, p);
    if (hits.length === 0) break; // no more results
    hits.forEach((h) => found.add(h.fullName));
    await sleep(300); // small delay between pages
  }
  return [...found];
}

/** Search by keyword (in:name,description). Returns unique fullNames. */
async function discoverKeyword(keyword: string, pages: number): Promise<string[]> {
  const date = new Date();
  date.setDate(date.getDate() - PUSHED_DAYS);
  const dateStr = date.toISOString().split('T')[0];
  const query = `"${keyword}" in:name,description stars:>${MIN_STARS} pushed:>${dateStr}`;
  const found = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    const hits = await searchPage(query, p);
    if (hits.length === 0) break;
    hits.forEach((h) => found.add(h.fullName));
    await sleep(300);
  }
  return [...found];
}

// ── Progress helpers ───────────────────────────────────────────────────────────

async function getIndexedCount(prisma: PrismaClient): Promise<number> {
  return prisma.indexedTool.count({ where: { index_status: 'indexed' } });
}

async function getPendingCount(prisma: PrismaClient): Promise<number> {
  return prisma.indexedTool.count({ where: { index_status: 'pending' } });
}

async function getStatusSummary(prisma: PrismaClient) {
  const [indexed, pending, failed, total] = await Promise.all([
    prisma.indexedTool.count({ where: { index_status: 'indexed' } }),
    prisma.indexedTool.count({ where: { index_status: 'pending' } }),
    prisma.indexedTool.count({ where: { index_status: 'failed' } }),
    prisma.indexedTool.count(),
  ]);
  return { indexed, pending, failed, total };
}

// ── Retry logic ────────────────────────────────────────────────────────────────

async function retryFailed(prisma: PrismaClient): Promise<number> {
  const failed = await prisma.indexedTool.findMany({
    where: { index_status: 'failed', retry_count: { lt: MAX_RETRIES } },
    select: { github_url: true, retry_count: true },
    orderBy: { retry_count: 'asc' },
    take: 500,
  });
  if (failed.length === 0) return 0;
  logger.info({ count: failed.length }, 'Retrying failed tools');
  let requeued = 0;
  for (const t of failed) {
    await prisma.indexedTool.update({
      where: { github_url: t.github_url },
      data: { index_status: 'pending', retry_count: { increment: 1 } },
    });
    await enqueueIndexJob(t.github_url, 5); // high priority for retries
    requeued++;
    await sleep(50);
  }
  logger.info({ requeued }, 'Failed tools re-queued');
  return requeued;
}

async function unstickPending(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_HOURS * 60 * 60 * 1000);
  const stuck = await prisma.indexedTool.findMany({
    where: { index_status: 'pending', updated_at: { lt: cutoff } },
    select: { github_url: true },
    take: 500,
  });
  if (stuck.length === 0) return 0;
  logger.info({ count: stuck.length, cutoffHours: STUCK_HOURS }, 'Un-sticking pending tools');
  let requeued = 0;
  for (const t of stuck) {
    await enqueueIndexJob(t.github_url, 3);
    await prisma.indexedTool.update({
      where: { github_url: t.github_url },
      data: { updated_at: new Date() }, // reset timestamp
    });
    requeued++;
    await sleep(50);
  }
  logger.info({ requeued }, 'Stuck tools re-queued');
  return requeued;
}

// ── Enqueue new discoveries ────────────────────────────────────────────────────

async function enqueueNewRepos(prisma: PrismaClient, fullNames: string[]): Promise<number> {
  if (fullNames.length === 0) return 0;
  // Bulk check which are already known
  const urls = fullNames.map((n) => `https://github.com/${n}`);
  const existing = await prisma.indexedTool.findMany({
    where: { github_url: { in: urls } },
    select: { github_url: true },
  });
  const existingSet = new Set(existing.map((e) => e.github_url));
  const newUrls = urls.filter((u) => !existingSet.has(u));
  if (newUrls.length === 0) return 0;

  let enqueued = 0;
  for (const url of newUrls) {
    try {
      await prisma.indexedTool.create({
        data: {
          github_url: url,
          index_status: 'pending',
          retry_count: 0,
          graph_node_id: null,
        },
      });
      if (!DRY_RUN) await enqueueIndexJob(url, 1);
      enqueued++;
    } catch {
      // Duplicate — already exists from a concurrent insert, skip
    }
  }
  return enqueued;
}

// ── Index pending jobs ─────────────────────────────────────────────────────────

async function processBatch(
  prisma: PrismaClient,
  batchSize: number,
  onNewlyIndexed: (count: number) => Promise<void>,
): Promise<number> {
  const pending = await prisma.indexedTool.findMany({
    where: { index_status: 'pending' },
    orderBy: [{ retry_count: 'asc' }, { created_at: 'asc' }],
    select: { github_url: true },
    take: batchSize,
  });
  if (pending.length === 0) return 0;

  let processed = 0;

  // Process in parallel chunks of CONCURRENCY
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const chunk = pending.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      chunk.map(async (t) => {
        await corePreFlight(); // respect GitHub Core rate limit
        try {
          await handleIndexJob(t.github_url, 1);
          processed++;
          await onNewlyIndexed(1);
        } catch (err) {
          logger.warn({ url: t.github_url, err: (err as Error).message }, 'Index job failed');
        }
      }),
    );
    await sleep(500); // brief pause between chunks
  }

  return processed;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();

  // Refresh initial rate limit state
  await refreshRateLimitsFromGitHub();

  const summary = await getStatusSummary(prisma);
  logger.info(
    { ...summary, target: TARGET_COUNT, minStars: MIN_STARS, dryRun: DRY_RUN },
    '🚀 Bulk indexer starting',
  );

  if (summary.indexed >= TARGET_COUNT) {
    logger.info({ indexed: summary.indexed, target: TARGET_COUNT }, '✅ Already at target!');
    await prisma.$disconnect();
    return;
  }

  // Import topics from existing scheduler
  const { DEFAULT_DISCOVERY_TOPICS } = await import('./schedulers/discovery-scheduler.js');

  const allTopics: string[] = DEFAULT_DISCOVERY_TOPICS;
  logger.info({ topics: allTopics.length, keywords: KEYWORD_QUERIES.length }, 'Search set ready');

  let totalNewlyIndexed = 0;
  let lastRetryAt = 0; // indexed count when we last ran retry

  // ── Phase 1: Discovery round ────────────────────────────────────────────────

  logger.info('📡 Phase 1: Discovery — searching GitHub for repos');

  // Topic searches
  let topicEnqueued = 0;
  for (const [i, topic] of allTopics.entries()) {
    const rl = getRateLimitStatus();
    if (rl.search.remaining < 5) {
      logger.warn('Search quota nearly exhausted — pausing topic discovery');
      await sleep(60_000);
    }

    const repos = await discoverTopic(topic, PAGES_PER_TOPIC);
    const enqueued = await enqueueNewRepos(prisma, repos);
    topicEnqueued += enqueued;

    if (i % 20 === 0 || enqueued > 0) {
      const s = await getStatusSummary(prisma);
      logger.info(
        {
          topic,
          progress: `${i + 1}/${allTopics.length}`,
          found: repos.length,
          newEnqueued: enqueued,
          totalPending: s.pending,
          indexed: s.indexed,
          target: TARGET_COUNT,
        },
        '📡 Topic discovery progress',
      );
    }

    await sleep(200); // pace between topics
  }

  // Keyword searches
  let kwEnqueued = 0;
  for (const [i, keyword] of KEYWORD_QUERIES.entries()) {
    const repos = await discoverKeyword(keyword, 3); // 3 pages per keyword
    const enqueued = await enqueueNewRepos(prisma, repos);
    kwEnqueued += enqueued;
    logger.info({ keyword, found: repos.length, newEnqueued: enqueued }, '🔍 Keyword search');
    await sleep(500);
  }

  logger.info(
    { topicEnqueued, kwEnqueued, total: topicEnqueued + kwEnqueued },
    '📦 Discovery complete — tools enqueued for indexing',
  );

  if (DRY_RUN) {
    const s = await getStatusSummary(prisma);
    logger.info(s, '🏜️  DRY_RUN=1 — stopping before indexing');
    await prisma.$disconnect();
    return;
  }

  // ── Phase 2+: Index loop ────────────────────────────────────────────────────

  logger.info('⚙️  Phase 2: Indexing discovered tools');

  const onNewlyIndexed = async (count: number) => {
    totalNewlyIndexed += count;

    // Every RETRY_INTERVAL new tools: retry failed + un-stick pending
    if (totalNewlyIndexed - lastRetryAt >= RETRY_INTERVAL) {
      lastRetryAt = totalNewlyIndexed;
      const s = await getStatusSummary(prisma);
      logger.info(
        {
          indexed: s.indexed,
          pending: s.pending,
          failed: s.failed,
          target: TARGET_COUNT,
          newSinceStart: totalNewlyIndexed,
        },
        `🔄 ${RETRY_INTERVAL}-tool checkpoint — running retries`,
      );
      await retryFailed(prisma);
      await unstickPending(prisma);
    }
  };

  // Main indexing loop — keeps going until target reached or queue empty
  let emptyRounds = 0;
  const MAX_EMPTY_ROUNDS = 3; // tolerate 3 empty batches before triggering re-discovery

  while (true) {
    const indexed = await getIndexedCount(prisma);

    if (indexed >= TARGET_COUNT) {
      logger.info({ indexed, target: TARGET_COUNT }, '🎉 TARGET REACHED!');
      break;
    }

    const processed = await processBatch(prisma, BATCH_SIZE, onNewlyIndexed);

    if (processed === 0) {
      emptyRounds++;
      const pending = await getPendingCount(prisma);
      logger.info({ emptyRounds, pending, indexed, target: TARGET_COUNT }, 'Empty batch');

      if (emptyRounds >= MAX_EMPTY_ROUNDS) {
        if (indexed >= TARGET_COUNT) break;

        // Re-run discovery with even lower stars to find more tools
        const newMinStars = Math.max(1, Math.floor(MIN_STARS / 2));
        logger.info(
          { newMinStars, indexed, target: TARGET_COUNT },
          '🔄 Queue empty — running additional discovery with lower star threshold',
        );

        for (const topic of allTopics.slice(0, 50)) {
          // top 50 topics
          const repos = await discoverTopic(topic, 2);
          await enqueueNewRepos(prisma, repos);
          await sleep(300);
        }
        emptyRounds = 0;
      }

      await sleep(2000); // wait before retrying empty batch
    } else {
      emptyRounds = 0;
      const s = await getStatusSummary(prisma);
      logger.info(
        {
          batchProcessed: processed,
          indexed: s.indexed,
          pending: s.pending,
          failed: s.failed,
          pctDone: `${((s.indexed / TARGET_COUNT) * 100).toFixed(1)}%`,
        },
        '📊 Batch complete',
      );
    }
  }

  // Final retry pass
  logger.info('🔄 Final retry pass on all failed tools');
  await retryFailed(prisma);
  await unstickPending(prisma);

  const final = await getStatusSummary(prisma);
  logger.info(
    {
      ...final,
      target: TARGET_COUNT,
      achieved: final.indexed >= TARGET_COUNT ? '✅ YES' : '⚠️ NOT YET',
    },
    '🏁 Bulk indexer finished',
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  logger.error(e, 'Bulk indexer crashed');
  process.exit(1);
});

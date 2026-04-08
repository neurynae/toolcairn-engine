/**
 * Manual Discovery Runner — triggers discovery on-demand.
 *
 * Usage:
 *   pnpm tsx src/run-discovery.ts
 *
 * Environment variables (override settings):
 *   TOPICS=ai,mcp,vector-db       — comma-separated topics (default: from AppSettings)
 *   BATCH_SIZE=50                 — max repos to enqueue (default: 20)
 *   MIN_STARS=500                 — minimum stars threshold (default: 100)
 *   PUSHED_DAYS=30                — only repos pushed within N days (default: 90)
 *   DRY_RUN=1                     — print what would be indexed without enqueuing
 */

import { PrismaClient } from '@toolcairn/db';
import pino from 'pino';
import { discoverReposAcrossTopics } from './crawlers/github-discovery.js';
import { runDiscoveryScheduler } from './schedulers/discovery-scheduler.js';

const logger = pino({ name: '@toolcairn/indexer:run-discovery' });

const DEFAULT_TOPICS = [
  'ai',
  'mcp',
  'mcp-server',
  'vector-db',
  'llm',
  'rag',
  'embedding',
  'chatbot',
  'agent',
  'autonomous-agent',
];

async function runDryRun(
  topics: string[],
  batchSize: number,
  minStars: number,
  pushedDays: number,
): Promise<void> {
  const prisma = new PrismaClient();

  try {
    // Discover repos from GitHub
    const discovered = await discoverReposAcrossTopics(topics, minStars, pushedDays, batchSize * 2);
    logger.info({ count: discovered.length }, 'Discovered repos from GitHub');

    // Check which are already indexed
    const indexed = await prisma.indexedTool.findMany({
      select: { github_url: true },
      where: { index_status: { in: ['indexed', 'pending'] } },
    });
    const indexedUrls = new Set(indexed.map((t) => t.github_url));

    const newRepos = discovered.filter(
      (repo) => !indexedUrls.has(`https://github.com/${repo.fullName}`),
    );
    const toEnqueue = newRepos.slice(0, batchSize);

    logger.info(
      {
        totalDiscovered: discovered.length,
        alreadyIndexed: discovered.length - newRepos.length,
        newToSystem: newRepos.length,
        wouldEnqueue: toEnqueue.length,
      },
      'DRY RUN — no jobs were enqueued',
    );

    for (const repo of toEnqueue) {
      logger.info(
        {
          repo: repo.fullName,
          stars: repo.stars,
          language: repo.language,
          lastPushed: repo.lastPushed.toISOString(),
        },
        'Would enqueue',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const envTopics = process.env.TOPICS;
  const envBatchSize = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);
  const envMinStars = Number.parseInt(process.env.MIN_STARS ?? '', 10);
  const envPushedDays = Number.parseInt(process.env.PUSHED_DAYS ?? '', 10);
  const dryRun = process.env.DRY_RUN === '1';

  const topics = envTopics ? envTopics.split(',').map((t) => t.trim()) : DEFAULT_TOPICS;
  const batchSize = envBatchSize > 0 ? envBatchSize : 20;
  const minStars = envMinStars > 0 ? envMinStars : 100;
  const pushedDays = envPushedDays > 0 ? envPushedDays : 90;

  logger.info(
    {
      TOPICS: topics.join(', '),
      BATCH_SIZE: batchSize,
      MIN_STARS: minStars,
      PUSHED_DAYS: pushedDays,
      DRY_RUN: dryRun,
    },
    'Starting manual discovery run',
  );

  try {
    if (dryRun) {
      await runDryRun(topics, batchSize, minStars, pushedDays);
    } else {
      const result = await runDiscoveryScheduler();
      logger.info(result, 'Discovery run complete');

      if (result.errors.length > 0) {
        logger.warn({ errorCount: result.errors.length }, 'Some errors occurred');
        for (const error of result.errors.slice(0, 5)) {
          logger.warn({ error }, 'Error detail');
        }
      }
    }

    process.exit(0);
  } catch (e) {
    logger.error({ err: e }, 'Discovery run failed');
    process.exit(1);
  }
}

main();

/**
 * Reindex Scheduler — enqueues ALL indexed tools for daily reprocessing.
 *
 * Design: enqueue everything every run. Efficiency comes from checkIfUnchanged()
 * in index-consumer.ts — tools with no changes (same description, stars, commits)
 * are skipped after just 1 GitHub API call. Only truly changed tools go through
 * the full 5-call crawl + reprocess pipeline.
 *
 * With ~17k tools and 2 GitHub tokens (10k req/hour combined), a full daily
 * reindex completes in ~2 hours (most tools skipped via checkIfUnchanged).
 *
 * Respects AppSettings.reindex_scheduler_enabled toggle.
 * force=true (manual trigger) bypasses the enabled check.
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { enqueueBatchReindex } from '@toolcairn/queue';

const logger = createLogger({ name: '@toolcairn/indexer:reindex-scheduler' });

async function isReindexEnabled(prisma: PrismaClient): Promise<boolean> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'global' },
    select: { reindex_scheduler_enabled: true },
  });
  return settings?.reindex_scheduler_enabled ?? true;
}

export async function runReindexScheduler(force = false): Promise<{
  found: number;
  enqueued: number;
}> {
  const prisma = new PrismaClient();
  try {
    // Manual trigger (force=true) bypasses the enabled check
    if (!force) {
      const enabled = await isReindexEnabled(prisma);
      if (!enabled) {
        logger.info('Reindex scheduler is disabled — skipping run');
        return { found: 0, enqueued: 0 };
      }
    }

    // Enqueue ALL indexed tools — no staleness filter, no batch cap.
    // checkIfUnchanged() in index-consumer handles efficiency: unchanged tools
    // cost only 1 API call and are skipped without full reprocessing.
    const allTools = await prisma.indexedTool.findMany({
      where: { index_status: { in: ['indexed', 'pending'] } },
      select: { github_url: true },
      orderBy: { last_indexed_at: 'asc' }, // oldest first for priority
    });

    if (allTools.length === 0) {
      logger.info('No tools found — reindex scheduler done');
      return { found: 0, enqueued: 0 };
    }

    const toolIds = allTools.map((t) => t.github_url);
    logger.info({ count: toolIds.length }, 'Enqueueing all tools for reindex');

    const result = await enqueueBatchReindex(toolIds);
    const enqueued = result.ok ? result.data : 0;

    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', last_reindex_run: new Date() },
      update: { last_reindex_run: new Date() },
    });

    logger.info({ found: allTools.length, enqueued }, 'Reindex scheduler complete');
    return { found: allTools.length, enqueued };
  } finally {
    await prisma.$disconnect();
  }
}

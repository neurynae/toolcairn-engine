/**
 * Reindex Scheduler — finds stale tools and enqueues low-priority re-index jobs.
 *
 * "Stale" = last_indexed_at older than STALE_THRESHOLD_DAYS, or never indexed.
 * Rate-limited to BATCH_SIZE tools per run to avoid exhausting the GitHub API.
 *
 * Respects AppSettings.reindex_scheduler_enabled toggle.
 */

import { PrismaClient } from '@toolcairn/db';
import { enqueueBatchReindex } from '@toolcairn/queue';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:reindex-scheduler' });

const STALE_THRESHOLD_DAYS = 7;
const BATCH_SIZE = 50;

/**
 * Check if reindex scheduler is enabled in AppSettings.
 */
async function isReindexEnabled(prisma: PrismaClient): Promise<boolean> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'global' },
    select: { reindex_scheduler_enabled: true },
  });
  // Default to true if settings don't exist yet
  return settings?.reindex_scheduler_enabled ?? true;
}

export async function runReindexScheduler(): Promise<{
  found: number;
  enqueued: number;
}> {
  const prisma = new PrismaClient();
  try {
    // Check if reindex is enabled
    const enabled = await isReindexEnabled(prisma);
    if (!enabled) {
      logger.info('Reindex scheduler is disabled — skipping run');
      return { found: 0, enqueued: 0 };
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_THRESHOLD_DAYS);

    // Find tools that are either never indexed or indexed more than STALE_THRESHOLD_DAYS ago
    const staleTools = await prisma.indexedTool.findMany({
      where: {
        index_status: { in: ['indexed', 'pending'] },
        OR: [{ last_indexed_at: null }, { last_indexed_at: { lt: cutoff } }],
      },
      select: {
        github_url: true,
        last_indexed_at: true,
        index_status: true,
      },
      orderBy: { last_indexed_at: 'asc' }, // oldest first
      take: BATCH_SIZE,
    });

    if (staleTools.length === 0) {
      logger.info('No stale tools found — reindex scheduler done');
      return { found: 0, enqueued: 0 };
    }

    const toolIds = staleTools.map((t) => t.github_url);
    logger.info({ count: toolIds.length }, 'Enqueueing batch reindex');

    const result = await enqueueBatchReindex(toolIds);
    const enqueued = result.ok ? result.data : 0;

    // Update last_reindex_run timestamp
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', last_reindex_run: new Date() },
      update: { last_reindex_run: new Date() },
    });

    logger.info({ found: staleTools.length, enqueued }, 'Reindex scheduler complete');
    return { found: staleTools.length, enqueued };
  } finally {
    await prisma.$disconnect();
  }
}

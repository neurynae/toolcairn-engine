/**
 * Pending Watchdog — re-enqueues tools stuck in 'pending' state.
 *
 * A tool ends up stuck as 'pending' in two scenarios:
 *   1. The Redis queue message was consumed but the index job failed before
 *      updating PostgreSQL status (crash, OOM, network timeout).
 *   2. The bulk-indexer process died after writing PostgreSQL records but
 *      before enqueuing/processing all of them via Redis.
 *
 * The watchdog runs every scheduler tick and re-enqueues any 'pending' tool
 * whose updated_at hasn't changed in > STUCK_THRESHOLD_MINUTES. This ensures
 * eventual processing without duplicating active work (tools currently being
 * processed update their updated_at every crawl).
 */

import type { PrismaClient } from '@toolcairn/db';
import { enqueueIndexJob } from '@toolcairn/queue';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:pending-watchdog' });

const STUCK_THRESHOLD_MINUTES = 30;
const BATCH_SIZE = 200;
const PRIORITY = 2; // higher than normal (1) to drain backlog faster

export interface WatchdogResult {
  found: number;
  requeued: number;
}

export async function runPendingWatchdog(prisma: PrismaClient): Promise<WatchdogResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

  const stuck = await prisma.indexedTool.findMany({
    where: {
      index_status: 'pending',
      updated_at: { lt: cutoff },
    },
    select: { github_url: true, updated_at: true },
    orderBy: { updated_at: 'asc' }, // oldest-stuck first
    take: BATCH_SIZE,
  });

  if (stuck.length === 0) return { found: 0, requeued: 0 };

  logger.info(
    {
      found: stuck.length,
      oldestStuckAt: stuck[0]?.updated_at,
      thresholdMinutes: STUCK_THRESHOLD_MINUTES,
    },
    'Pending watchdog: found stuck tools — re-enqueuing',
  );

  let requeued = 0;
  for (const tool of stuck) {
    const result = await enqueueIndexJob(tool.github_url, PRIORITY);
    if (result.ok) {
      // Reset updated_at so this tool doesn't trigger again next tick
      await prisma.indexedTool.update({
        where: { github_url: tool.github_url },
        data: { updated_at: new Date() },
      });
      requeued++;
    } else {
      logger.warn({ url: tool.github_url, error: result.error }, 'Watchdog: failed to re-enqueue');
    }
  }

  logger.info({ found: stuck.length, requeued }, 'Pending watchdog complete');
  return { found: stuck.length, requeued };
}

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
import { createLogger } from '@toolcairn/errors';
import { enqueueIndexJob } from '@toolcairn/queue';

const logger = createLogger({ name: '@toolcairn/indexer:pending-watchdog' });

const STUCK_THRESHOLD_MINUTES = 30;
const BATCH_SIZE = 200;
const PRIORITY = 2; // higher than normal (1) to drain backlog faster

/**
 * Tools that have been requeued this many times without succeeding are marked
 * `failed` with `repeated_failures` and stop entering the queue. Prevents the
 * feedback loop where oversized repos OOM the indexer process on every retry,
 * leaving messages unacked in the Redis PEL and causing the watchdog to pile
 * up duplicate enqueues each cycle.
 */
const MAX_RETRY_COUNT = 3;

export interface WatchdogResult {
  found: number;
  requeued: number;
  abandoned: number;
}

export async function runPendingWatchdog(prisma: PrismaClient): Promise<WatchdogResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

  const stuck = await prisma.indexedTool.findMany({
    where: {
      index_status: 'pending',
      updated_at: { lt: cutoff },
    },
    select: { github_url: true, updated_at: true, retry_count: true },
    orderBy: { updated_at: 'asc' }, // oldest-stuck first
    take: BATCH_SIZE,
  });

  if (stuck.length === 0) return { found: 0, requeued: 0, abandoned: 0 };

  logger.info(
    {
      found: stuck.length,
      oldestStuckAt: stuck[0]?.updated_at,
      thresholdMinutes: STUCK_THRESHOLD_MINUTES,
    },
    'Pending watchdog: found stuck tools — re-enqueuing',
  );

  let requeued = 0;
  let abandoned = 0;
  for (const tool of stuck) {
    // Retry cap — stop re-enqueuing tools that have failed repeatedly. Most
    // often this is oversized repos that OOM the Node process mid-processing.
    if ((tool.retry_count ?? 0) >= MAX_RETRY_COUNT) {
      await prisma.indexedTool.update({
        where: { github_url: tool.github_url },
        data: {
          index_status: 'failed',
          error_message: `repeated_failures: abandoned after ${tool.retry_count} retries (watchdog)`,
          skip_reason: 'max_retries_exceeded',
          updated_at: new Date(),
        },
      });
      abandoned++;
      logger.warn(
        { url: tool.github_url, retryCount: tool.retry_count },
        'Watchdog: abandoning tool — max retries exceeded',
      );
      continue;
    }

    const result = await enqueueIndexJob(tool.github_url, PRIORITY);
    if (result.ok) {
      // Increment retry_count so future stuck cycles eventually hit the cap.
      // Reset updated_at so this tool doesn't trigger again next tick.
      await prisma.indexedTool.update({
        where: { github_url: tool.github_url },
        data: {
          updated_at: new Date(),
          retry_count: (tool.retry_count ?? 0) + 1,
        },
      });
      requeued++;
    } else {
      logger.warn({ url: tool.github_url, error: result.error }, 'Watchdog: failed to re-enqueue');
    }
  }

  logger.info({ found: stuck.length, requeued, abandoned }, 'Pending watchdog complete');
  return { found: stuck.length, requeued, abandoned };
}

/**
 * Restore: re-queue all 'removed' tools from Postgres for re-indexing.
 *
 * After the April 11 cleanup accidentally removed high-star canonical tools
 * (React 234k★, Kubernetes 118k★, etc.), this script re-queues them so the
 * indexer re-crawls fresh data from GitHub. The universal 1k star gate in
 * index-consumer.ts will skip tools that genuinely have < 1000 stars.
 *
 * Run cleanup-sub1k-all-dbs.ts FIRST to evict name squatters, then this
 * script to restore the canonical tools to their rightful name slots.
 *
 * Usage:
 *   pnpm tsx src/restore-removed-tools.ts          # dry run (count only)
 *   pnpm tsx src/restore-removed-tools.ts --enqueue # actually enqueue
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { enqueueIndexJob } from '@toolcairn/queue';

const logger = createLogger({ name: '@toolcairn/indexer:restore-removed' });
const DRY_RUN = !process.argv.includes('--enqueue');

async function main() {
  const prisma = new PrismaClient();

  try {
    const removed = await prisma.indexedTool.findMany({
      where: { index_status: 'removed' },
      select: { github_url: true },
    });

    logger.info({ total: removed.length }, 'Found removed tools to re-queue');

    if (DRY_RUN) {
      const sample = removed.slice(0, 20).map((t) => t.github_url);
      logger.info({ sample }, 'Sample URLs');
      logger.info('Re-run with --enqueue to commit');
      return;
    }

    // Reset status to 'pending' so the indexer can process them
    await prisma.indexedTool.updateMany({
      where: { index_status: 'removed' },
      data: { index_status: 'pending', updated_at: new Date() },
    });
    logger.info({ count: removed.length }, 'Reset status to pending');

    // Enqueue into Redis for re-indexing
    let enqueued = 0;
    let failed = 0;

    for (const tool of removed) {
      try {
        const result = await enqueueIndexJob(tool.github_url, 0);
        if (result.ok) {
          enqueued++;
        } else {
          failed++;
          if (failed <= 10) {
            logger.warn({ url: tool.github_url, error: result.error }, 'Failed to enqueue');
          }
        }
      } catch (e) {
        failed++;
        if (failed <= 10) {
          logger.warn({ url: tool.github_url, err: e }, 'Enqueue threw');
        }
      }

      if (enqueued % 500 === 0 && enqueued > 0) {
        logger.info({ enqueued, failed, total: removed.length }, 'Enqueue progress');
      }
    }

    logger.info({ enqueued, failed, total: removed.length }, 'Restore complete');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Enqueue ALL indexed tools for reprocessing.
 * Directly pushes index jobs to Redis Streams — the worker consumes them.
 *
 * Usage: pnpm tsx src/enqueue-all.ts
 */

import { PrismaClient } from '@toolcairn/db';
import { enqueueIndexJob } from '@toolcairn/queue';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:enqueue-all' });

async function main() {
  const prisma = new PrismaClient();

  try {
    const tools = await prisma.indexedTool.findMany({
      where: { index_status: { in: ['indexed', 'pending'] } },
      select: { github_url: true },
    });

    logger.info({ total: tools.length }, 'Enqueuing all tools for reindex');

    let enqueued = 0;
    let failed = 0;

    for (const tool of tools) {
      const result = await enqueueIndexJob(tool.github_url, 0);
      if (result.ok) {
        enqueued++;
      } else {
        failed++;
        logger.warn({ url: tool.github_url, error: result.error }, 'Failed to enqueue');
      }
    }

    logger.info({ enqueued, failed, total: tools.length }, 'Enqueue complete');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

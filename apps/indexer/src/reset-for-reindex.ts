/**
 * Reset all indexed tools' last_indexed_at to force a full reindex.
 * Run once, then trigger the reindex scheduler.
 *
 * Usage: pnpm tsx src/reset-for-reindex.ts
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:reset-for-reindex' });

async function main() {
  const prisma = new PrismaClient();

  try {
    const result = await prisma.indexedTool.updateMany({
      where: { index_status: 'indexed' },
      data: { last_indexed_at: null },
    });

    logger.info({ count: result.count }, 'Reset last_indexed_at for all indexed tools');

    // Also reset failed tools to pending so they retry
    const failed = await prisma.indexedTool.updateMany({
      where: { index_status: 'failed' },
      data: { index_status: 'pending', last_indexed_at: null },
    });

    logger.info({ count: failed.count }, 'Reset failed tools to pending');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Cleanup: remove ALL tools with stars < 1000 from Qdrant, Memgraph, and Postgres.
 *
 * This evicts name squatters (e.g. mortylabs/kubernetes at 26★ occupying the
 * "kubernetes" slot) so that canonical high-star tools can reclaim their slots
 * when re-indexed.
 *
 * Operates on Qdrant as source of truth (has full ToolNode payloads with stars).
 * For each sub-1k tool found:
 *   1. Delete from Qdrant by point ID
 *   2. Delete from Memgraph by github_url (avoids name collision issues)
 *   3. Update Postgres status to 'removed'
 *
 * Usage:
 *   pnpm tsx src/cleanup-sub1k-all-dbs.ts          # dry run
 *   pnpm tsx src/cleanup-sub1k-all-dbs.ts --delete # commit changes
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:cleanup-sub1k' });
const DRY_RUN = !process.argv.includes('--delete');
const STAR_THRESHOLD = 1000;

interface ToolPayload {
  name: string;
  github_url: string;
  health: { stars: number };
}

async function main() {
  if (DRY_RUN) logger.info('DRY RUN — pass --delete to commit changes');

  const client = qdrantClient();
  const prisma = new PrismaClient();

  const toDelete: Array<{ pointId: string; name: string; githubUrl: string; stars: number }> = [];
  let offset: string | number | null | undefined = undefined;
  const PAGE_SIZE = 500;

  // 1. Scroll Qdrant and find all sub-1k tools
  while (true) {
    const result = await client.scroll(COLLECTION_NAME, {
      limit: PAGE_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    const points = result.points as Array<{
      id: string | number;
      payload: Record<string, unknown> | null;
    }>;

    for (const point of points) {
      if (!point.payload) continue;
      const tool = point.payload as unknown as ToolPayload;
      if (tool.health.stars < STAR_THRESHOLD) {
        toDelete.push({
          pointId: String(point.id),
          name: tool.name,
          githubUrl: tool.github_url,
          stars: tool.health.stars,
        });
      }
    }

    const nextOffset = result.next_page_offset as string | number | null | undefined;
    if (!nextOffset) break;
    offset = nextOffset;
    logger.info({ scanned: toDelete.length, offset: nextOffset }, 'Scanning Qdrant...');
  }

  logger.info({ total: toDelete.length }, `Found tools with < ${STAR_THRESHOLD} stars`);

  if (DRY_RUN) {
    const sample = toDelete.slice(0, 20).map((t) => `${t.name} (${t.stars}★) ${t.githubUrl}`);
    logger.info({ sample }, 'Sample of tools to delete');
    logger.info('Re-run with --delete to commit');
    await prisma.$disconnect();
    return;
  }

  // 2. Delete from Qdrant in batches
  const BATCH = 100;
  let qdrantDeleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH);
    const ids = batch.map((t) => t.pointId);
    try {
      await client.delete(COLLECTION_NAME, { points: ids });
      qdrantDeleted += ids.length;
    } catch (e) {
      logger.error({ err: e, batch: i }, 'Qdrant batch delete failed');
    }
    if (qdrantDeleted % 500 === 0) {
      logger.info({ qdrantDeleted, total: toDelete.length }, 'Qdrant delete progress');
    }
  }
  logger.info({ qdrantDeleted }, 'Qdrant cleanup complete');

  // 3. Delete from Memgraph by github_url (NOT by name — avoids nuking wrong tool)
  let memgraphDeleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH);
    const urls = batch.map((t) => t.githubUrl);
    const session = getMemgraphSession();
    try {
      await session.run('MATCH (t:Tool) WHERE t.github_url IN $urls DETACH DELETE t', { urls });
      memgraphDeleted += urls.length;
    } catch (e) {
      logger.error({ err: e, batch: i }, 'Memgraph batch delete failed');
    } finally {
      await session.close();
    }
    if (memgraphDeleted % 500 === 0) {
      logger.info({ memgraphDeleted, total: toDelete.length }, 'Memgraph delete progress');
    }
  }
  logger.info({ memgraphDeleted }, 'Memgraph cleanup complete');

  // 4. Update Postgres status to 'removed'
  let pgUpdated = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH);
    const urls = batch.map((t) => t.githubUrl);
    try {
      await prisma.indexedTool.updateMany({
        where: { github_url: { in: urls } },
        data: { index_status: 'removed', updated_at: new Date() },
      });
      pgUpdated += urls.length;
    } catch (e) {
      logger.error({ err: e, batch: i }, 'Postgres batch update failed');
    }
  }
  logger.info({ pgUpdated }, 'Postgres status update complete');

  logger.info(
    { qdrantDeleted, memgraphDeleted, pgUpdated },
    'Cleanup complete — sub-1k tools removed from all databases',
  );

  await prisma.$disconnect();
  await closeMemgraphDriver().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

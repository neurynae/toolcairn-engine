/**
 * Click/selection feedback loop — update search_weight from outcome reports.
 *
 * When users report a tool as 'success' via report_outcome, that tool's
 * search_weight is incremented slightly. Over time, tools that consistently
 * solve real problems get a small but meaningful ranking boost.
 *
 * search_weight: default 1.0, max 2.0. Multiplied into Stage 2 scoring.
 * Each successful outcome: +0.02 (capped). Run daily via cron.
 *
 * Usage: pnpm tsx src/update-search-weights.ts
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:update-search-weights' });
const WEIGHT_INCREMENT = 0.02;
const MAX_WEIGHT = 2.0;

async function main() {
  const prisma = new PrismaClient();
  const session = getMemgraphSession();
  const client = qdrantClient();

  try {
    // Fetch unprocessed successful outcomes grouped by tool
    const outcomes = await prisma.outcomeReport.groupBy({
      by: ['chosen_tool'],
      where: { outcome: 'success' },
      _count: { chosen_tool: true },
    });

    if (outcomes.length === 0) {
      logger.info('No new successful outcomes to process');
      return;
    }

    logger.info({ toolCount: outcomes.length }, 'Processing outcome feedback');

    let updated = 0;
    for (const outcome of outcomes) {
      const toolName = outcome.chosen_tool;
      const successCount = outcome._count.chosen_tool;
      const delta = Math.min(successCount * WEIGHT_INCREMENT, 0.2); // cap per run

      // Update Memgraph
      await session.run(
        `MATCH (t:Tool {name: $name})
         SET t.search_weight = CASE
           WHEN coalesce(t.search_weight, 1.0) + $delta > $max THEN $max
           ELSE coalesce(t.search_weight, 1.0) + $delta
         END`,
        { name: toolName, delta, max: MAX_WEIGHT },
      );

      // Update Qdrant payload
      const qResult = await client.scroll(COLLECTION_NAME, {
        filter: { must: [{ key: 'name', match: { value: toolName } }] },
        limit: 5,
        with_payload: ['search_weight'],
        with_vector: false,
      });

      for (const point of qResult.points as Array<{
        id: string | number;
        payload: Record<string, unknown> | null;
      }>) {
        const current = (point.payload?.search_weight as number | null) ?? 1.0;
        const newWeight = Math.min(current + delta, MAX_WEIGHT);
        await client.setPayload(COLLECTION_NAME, {
          payload: { search_weight: newWeight },
          points: [String(point.id)],
        });
      }

      updated++;
    }

    logger.info({ updated }, 'Search weight update complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

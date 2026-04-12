/**
 * Batch migration: compute REPLACES edges from vector embedding similarity.
 *
 * For each tool in Qdrant, finds the most similar tools using the recommend() API.
 * If cosine similarity exceeds the threshold and no INTEGRATES_WITH edge exists,
 * creates a REPLACES edge — marking these tools as alternatives.
 *
 * Usage:
 *   pnpm tsx src/run-compute-replaces.ts
 *
 * Environment variables:
 *   SIMILARITY_THRESHOLD=0.82  — cosine threshold for REPLACES (default: 0.82)
 *   BATCH_SIZE=10              — concurrent recommend calls per batch (default: 10)
 *   DRY_RUN=1                  — log what would be done without writing
 *   START_OFFSET=0             — skip first N tools (for resume)
 */

import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository, closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:compute-replaces' });

// ─── Config ─────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD) || 0.82;
const EDGE_WEIGHT_SCALE = 0.8;
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 10;
const RECOMMEND_LIMIT = 15;
const DRY_RUN = process.env.DRY_RUN === '1';
const START_OFFSET = Number(process.env.START_OFFSET) || 0;
const DECAY_RATE = 0.003; // slow decay for computed edges

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolPoint {
  id: string;
  name: string;
}

interface Stats {
  toolsProcessed: number;
  toolsSkipped: number;
  edgesCreated: number;
  edgesSkippedIntegration: number;
  errors: number;
}

// ─── Qdrant helpers ─────────────────────────────────────────────────────────

/**
 * Scroll all tool points from Qdrant (paginated).
 * Returns id + name for each point.
 */
async function scrollAllTools(): Promise<ToolPoint[]> {
  const tools: ToolPoint[] = [];
  let offset: string | number | undefined = undefined;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const page = await qdrantClient().scroll(COLLECTION_NAME, {
      limit: 500,
      ...(offset != null ? { offset } : {}),
      with_payload: { include: ['name'] },
      with_vector: false,
    });

    for (const point of page.points) {
      const name = (point.payload as Record<string, unknown>)?.name;
      if (typeof name === 'string') {
        tools.push({ id: String(point.id), name });
      }
    }

    const nextOffset = page.next_page_offset as string | number | null | undefined;
    if (nextOffset == null) break;
    offset = nextOffset;
  }

  return tools;
}

/**
 * Find similar tools using Qdrant's recommend API.
 * Returns tool IDs + names + cosine scores above threshold.
 */
async function findSimilar(
  toolId: string,
): Promise<Array<{ id: string; name: string; score: number }>> {
  try {
    const results = await qdrantClient().recommend(COLLECTION_NAME, {
      positive: [toolId],
      limit: RECOMMEND_LIMIT,
      with_payload: { include: ['name', 'id'] },
    });

    return results
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .map((r) => ({
        id: String((r.payload as Record<string, unknown>)?.id ?? r.id),
        name: String((r.payload as Record<string, unknown>)?.name ?? ''),
        score: r.score,
      }));
  } catch (e) {
    logger.warn({ toolId, err: e }, 'recommend() failed');
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  logger.info(
    { SIMILARITY_THRESHOLD, BATCH_SIZE, RECOMMEND_LIMIT, DRY_RUN, START_OFFSET },
    'Starting REPLACES edge computation',
  );

  // 1. Scroll all tools from Qdrant
  logger.info('Scrolling all tool points from Qdrant...');
  const allTools = await scrollAllTools();
  logger.info({ count: allTools.length }, 'Loaded all tool points');

  const repo = new MemgraphToolRepository();
  const stats: Stats = {
    toolsProcessed: 0,
    toolsSkipped: 0,
    edgesCreated: 0,
    edgesSkippedIntegration: 0,
    errors: 0,
  };

  // 2. Process tools in batches
  const toolsToProcess = allTools.slice(START_OFFSET);
  logger.info({ total: toolsToProcess.length, offset: START_OFFSET }, 'Processing tools');

  for (let i = 0; i < toolsToProcess.length; i += BATCH_SIZE) {
    const batch = toolsToProcess.slice(i, i + BATCH_SIZE);

    // Run recommend calls in parallel within batch
    const batchResults = await Promise.all(
      batch.map(async (tool) => {
        const similar = await findSimilar(tool.id);
        return { tool, similar };
      }),
    );

    // Process results sequentially (Memgraph sessions are sequential)
    for (const { tool, similar } of batchResults) {
      for (const neighbor of similar) {
        if (neighbor.name === tool.name) continue;

        // Check if INTEGRATES_WITH edge exists — if so, skip (complementary, not alternative)
        const edgeResult = await repo.getDirectEdges(tool.name, neighbor.name);
        if (edgeResult.ok) {
          const hasIntegration = edgeResult.data.some((e) => e.edgeType === 'INTEGRATES_WITH');
          if (hasIntegration) {
            stats.edgesSkippedIntegration++;
            continue;
          }

          // Skip if REPLACES already exists
          const hasReplaces = edgeResult.data.some((e) => e.edgeType === 'REPLACES');
          if (hasReplaces) continue;
        }

        const weight = Math.round(neighbor.score * EDGE_WEIGHT_SCALE * 1000) / 1000;

        if (DRY_RUN) {
          logger.info(
            { source: tool.name, target: neighbor.name, score: neighbor.score, weight },
            '[DRY_RUN] Would create REPLACES edge',
          );
          stats.edgesCreated++;
        } else {
          const upsertResult = await repo.upsertEdge({
            type: 'REPLACES',
            source_id: tool.id,
            target_id: neighbor.id,
            properties: {
              weight,
              confidence: 0.7,
              last_verified: new Date().toISOString(),
              source: 'vector_similarity',
              decay_rate: DECAY_RATE,
            },
          });

          if (upsertResult.ok) {
            stats.edgesCreated++;
          } else {
            stats.errors++;
            logger.warn(
              { source: tool.name, target: neighbor.name, error: upsertResult.error },
              'Failed to create REPLACES edge',
            );
          }
        }
      }

      stats.toolsProcessed++;
    }

    // Progress log every 500 tools
    if ((stats.toolsProcessed + START_OFFSET) % 500 < BATCH_SIZE) {
      logger.info(
        {
          processed: stats.toolsProcessed + START_OFFSET,
          total: allTools.length,
          edgesCreated: stats.edgesCreated,
          skippedIntegration: stats.edgesSkippedIntegration,
          errors: stats.errors,
        },
        'Progress',
      );
    }
  }

  // 3. Summary
  logger.info(stats, 'REPLACES edge computation complete');

  // Verify with Memgraph count
  const session = getMemgraphSession();
  try {
    const countResult = await session.run('MATCH ()-[r:REPLACES]->() RETURN count(r) AS total');
    const total = countResult.records[0]?.get('total');
    logger.info({ totalReplacesEdges: Number(total) }, 'Total REPLACES edges in graph');
  } finally {
    await session.close();
  }

  await closeMemgraphDriver();
}

main().catch((e) => {
  logger.error({ err: e }, 'Fatal error in compute-replaces');
  process.exit(1);
});

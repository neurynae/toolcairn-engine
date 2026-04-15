/**
 * Compute PageRank scores for all Tool nodes using Memgraph MAGE.
 * Normalized to [0,1]. Stored on both Memgraph and Qdrant payloads.
 *
 * High PageRank → tool is central and authoritative in the ecosystem graph.
 * Used in GET_TOOL_GRAPH_RERANK as an additional 0.15-weight signal in Stage 3.
 *
 * Run weekly via cron. Usage: pnpm tsx src/compute-pagerank.ts
 */

import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:compute-pagerank' });

async function main() {
  const session = getMemgraphSession();
  const client = qdrantClient();

  const pageranks = new Map<string, number>(); // tool name → normalized rank

  try {
    // Try Memgraph MAGE pagerank procedure first
    logger.info('Running PageRank via MAGE...');
    try {
      const result = await session.run(
        'CALL pagerank.get() YIELD node, rank WITH node, rank WHERE "Tool" IN labels(node) RETURN node.name AS name, rank',
      );

      let maxRank = 0;
      const rawRanks: Array<{ name: string; rank: number }> = [];

      for (const r of result.records) {
        const name = r.get('name') as string;
        const rank = r.get('rank') as number;
        if (name) {
          rawRanks.push({ name, rank });
          if (rank > maxRank) maxRank = rank;
        }
      }

      if (maxRank > 0) {
        for (const { name, rank } of rawRanks) {
          pageranks.set(name, rank / maxRank);
        }
        logger.info({ toolCount: pageranks.size, maxRank }, 'MAGE PageRank complete');
      }
    } catch {
      // MAGE not available — fall back to simplified iterative PageRank
      logger.warn('MAGE pagerank.get() unavailable — running TypeScript fallback');
      await computeFallbackPageRank(session, pageranks);
    }

    if (pageranks.size === 0) {
      logger.warn('No PageRank scores computed — skipping sync');
      return;
    }

    // Write back to Memgraph
    logger.info('Writing PageRank scores to Memgraph...');
    const names = [...pageranks.keys()];
    for (let i = 0; i < names.length; i += 500) {
      const batch = names.slice(i, i + 500);
      for (const name of batch) {
        const score = pageranks.get(name) ?? 0;
        await session.run('MATCH (t:Tool {name: $name}) SET t.pagerank_score = $score', {
          name,
          score,
        });
      }
      if (i % 5000 === 0) logger.info({ written: i }, 'Memgraph write progress');
    }

    // Sync to Qdrant payloads
    logger.info('Syncing PageRank to Qdrant payloads...');
    let offset: string | number | null | undefined = undefined;
    let totalSynced = 0;

    while (true) {
      const scrollResult = await client.scroll(COLLECTION_NAME, {
        limit: 500,
        offset,
        with_payload: ['name'],
        with_vector: false,
      });

      const points = scrollResult.points as Array<{
        id: string | number;
        payload: Record<string, unknown> | null;
      }>;

      if (points.length === 0) break;

      for (const point of points) {
        const name = point.payload?.name as string | undefined;
        if (!name) continue;
        const score = pageranks.get(name) ?? 0;
        await client.setPayload(COLLECTION_NAME, {
          payload: { pagerank_score: score },
          points: [String(point.id)],
        });
        totalSynced++;
      }

      const nextOffset = scrollResult.next_page_offset as string | number | null | undefined;
      if (!nextOffset) break;
      offset = nextOffset;

      if (totalSynced % 5000 === 0) logger.info({ totalSynced }, 'Qdrant sync progress');
    }

    logger.info({ totalSynced }, 'PageRank sync complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

/** Simplified iterative PageRank when MAGE is unavailable. */
async function computeFallbackPageRank(
  session: ReturnType<typeof getMemgraphSession>,
  pageranks: Map<string, number>,
): Promise<void> {
  const DAMPING = 0.85;
  const ITERATIONS = 20;

  // Build adjacency: source → [targets]
  const adjResult = await session.run(
    `MATCH (a:Tool)-[:INTEGRATES_WITH|COMPATIBLE_WITH|POPULAR_WITH]->(b:Tool)
     RETURN a.name AS src, b.name AS dst`,
  );

  const outEdges = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const r of adjResult.records) {
    const src = r.get('src') as string;
    const dst = r.get('dst') as string;
    if (!src || !dst) continue;
    allNodes.add(src);
    allNodes.add(dst);
    const edges = outEdges.get(src) ?? [];
    edges.push(dst);
    outEdges.set(src, edges);
  }

  const N = allNodes.size;
  if (N === 0) return;

  const ranks = new Map<string, number>();
  for (const node of allNodes) ranks.set(node, 1 / N);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newRanks = new Map<string, number>();
    for (const node of allNodes) {
      newRanks.set(node, (1 - DAMPING) / N);
    }
    for (const [src, targets] of outEdges) {
      const srcRank = ranks.get(src) ?? 0;
      const share = srcRank / targets.length;
      for (const dst of targets) {
        newRanks.set(dst, (newRanks.get(dst) ?? 0) + DAMPING * share);
      }
    }
    for (const [node, rank] of newRanks) ranks.set(node, rank);
  }

  const maxRank = Math.max(...ranks.values(), 0.0001);
  for (const [name, rank] of ranks) {
    pageranks.set(name, rank / maxRank);
  }

  logger.info({ toolCount: pageranks.size }, 'Fallback PageRank complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

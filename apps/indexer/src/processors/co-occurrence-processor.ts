/**
 * Co-occurrence Processor — builds CO_OCCURS_WITH edges in Memgraph.
 *
 * Reads completed SearchSessions from Postgres that have tool results,
 * computes pairwise tool co-occurrence, and upserts edges in Memgraph.
 *
 * Minimum threshold: a pair must appear together in 3+ sessions before
 * an edge is created. This prevents noise from single-session coincidences.
 */

import { prisma } from '@toolcairn/db';
import { getMemgraphSession } from '@toolcairn/graph';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:co-occurrence' });
const MIN_SESSIONS = 3;

interface SearchResult {
  results: Array<{ tool?: { name?: string } }>;
}

export async function processCoOccurrences(
  batchSize = 500,
): Promise<{ processed: number; edges: number }> {
  // Find unprocessed completed sessions
  const sessions = await prisma.searchSession.findMany({
    where: {
      status: 'completed',
      co_occurrence_processed: false,
    },
    take: batchSize,
    select: { id: true, results: true },
  });

  if (sessions.length === 0) return { processed: 0, edges: 0 };

  // Tally pair co-occurrences across sessions
  const pairCounts = new Map<string, number>();

  for (const session of sessions) {
    const results = session.results as SearchResult | null;
    const toolNames = (results?.results ?? [])
      .map((r) => r.tool?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    if (toolNames.length < 2) continue;

    // Generate all pairs from this session
    for (let i = 0; i < toolNames.length - 1; i++) {
      for (let j = i + 1; j < toolNames.length; j++) {
        const a = toolNames[i] as string;
        const b = toolNames[j] as string;
        const key = [a, b].sort().join('||');
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Upsert edges for pairs meeting the threshold
  const now = new Date().toISOString();
  const memgraph = getMemgraphSession();
  let edges = 0;

  try {
    for (const [key, count] of pairCounts) {
      if (count < MIN_SESSIONS) continue;
      const [nameA, nameB] = key.split('||');
      if (!nameA || !nameB) continue;

      try {
        await memgraph.run(
          `MATCH (a:Tool {name: $name_a}), (b:Tool {name: $name_b})
           MERGE (a)-[e:CO_OCCURS_WITH]-(b)
           ON CREATE SET e.weight = $weight, e.session_count = $count, e.last_seen = $now
           ON MATCH SET e.weight = e.weight + $weight,
                        e.session_count = e.session_count + $count,
                        e.last_seen = $now`,
          { name_a: nameA, name_b: nameB, weight: count * 0.1, count, now },
        );
        edges++;
      } catch {
        // Tool might not exist in graph — skip
      }
    }
  } finally {
    await memgraph.close();
  }

  // Mark sessions as processed
  const ids = sessions.map((s) => s.id);
  await prisma.searchSession.updateMany({
    where: { id: { in: ids } },
    data: { co_occurrence_processed: true },
  });

  logger.info(
    { processed: sessions.length, pairsChecked: pairCounts.size, edgesUpserted: edges },
    'Co-occurrence batch complete',
  );
  return { processed: sessions.length, edges };
}

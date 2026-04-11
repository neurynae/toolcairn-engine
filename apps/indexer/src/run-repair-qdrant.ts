/**
 * Repairs the Qdrant tools collection by upserting every tool that exists in
 * Memgraph but is missing from Qdrant (e.g. tools indexed before the
 * zero-vector fallback was added).
 *
 * Run with:
 *   cd apps/indexer && pnpm exec tsx src/run-repair-qdrant.ts
 */
import { getMemgraphSession } from '@toolcairn/graph';
import { mapRecordToToolNode } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:repair-qdrant' });
const VECTOR_SIZE = 768;
const BATCH_SIZE = 50;

async function fetchAllMemgraphTools() {
  const session = getMemgraphSession();
  try {
    const result = await session.run('MATCH (t:Tool) RETURN t ORDER BY t.name');
    return result.records.map((r) => mapRecordToToolNode(r.toObject()));
  } finally {
    await session.close();
  }
}

async function fetchQdrantIds(): Promise<Set<string>> {
  const client = qdrantClient();
  const ids = new Set<string>();
  let offset: string | number | null = null;

  // Paginate through all points (IDs only, no payload needed)
  do {
    const resp = await client.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: false,
      with_vector: false,
      ...(offset != null ? { offset } : {}),
    });
    for (const point of resp.points as Array<{ id: string | number }>) {
      ids.add(String(point.id));
    }
    offset = (resp.next_page_offset as string | number | null | undefined) ?? null;
  } while (offset != null);

  return ids;
}

async function main(): Promise<void> {
  logger.info('Fetching all tools from Memgraph…');
  const tools = await fetchAllMemgraphTools();
  logger.info({ total: tools.length }, 'Memgraph tools loaded');

  logger.info('Fetching existing Qdrant IDs…');
  const qdrantIds = await fetchQdrantIds();
  logger.info({ total: qdrantIds.size }, 'Qdrant IDs loaded');

  const missing = tools.filter((t) => !qdrantIds.has(t.id));
  logger.info({ missing: missing.length }, 'Tools missing from Qdrant');

  if (missing.length === 0) {
    logger.info('Nothing to repair.');
    process.exit(0);
  }

  const client = qdrantClient();
  const zeroVector = new Array(VECTOR_SIZE).fill(0);
  let repaired = 0;
  let failed = 0;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      await client.upsert(COLLECTION_NAME, {
        points: batch.map((tool) => ({
          id: tool.id,
          vector: zeroVector,
          payload: tool as unknown as Record<string, unknown>,
        })),
      });
      repaired += batch.length;
      logger.info(
        { repaired, total: missing.length, batch: batch.map((t) => t.name) },
        'Batch upserted',
      );
    } catch (e) {
      failed += batch.length;
      logger.error({ err: e, names: batch.map((t) => t.name) }, 'Batch upsert failed');
    }
  }

  logger.info({ repaired, failed }, 'Repair complete');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Repair script failed');
  process.exit(1);
});

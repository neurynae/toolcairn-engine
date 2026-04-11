import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { IndexerError } from '../errors.js';

const logger = createLogger({ name: '@toolcairn/indexer:qdrant-writer' });

const VECTOR_SIZE = 768;

const BATCH_SIZE = 100;

/**
 * Upsert a ToolNode and its vector embedding into Qdrant.
 * When no NOMIC_API_KEY is available, the embedding will be empty ([]).
 * In that case we fall back to a zero vector so the payload is still stored
 * and BM25 keyword search works — vector similarity will return 0.0 for all.
 */
export async function upsertToolVector(tool: ToolNode, vector: number[]): Promise<void> {
  const safeVector = vector.length === VECTOR_SIZE ? vector : new Array(VECTOR_SIZE).fill(0);
  if (vector.length !== VECTOR_SIZE) {
    logger.warn(
      { toolId: tool.id, toolName: tool.name, vecLen: vector.length },
      'Embedding missing — using zero vector (BM25 only)',
    );
  }
  try {
    const client = qdrantClient();
    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: tool.id,
          vector: safeVector,
          payload: tool as unknown as Record<string, unknown>,
        },
      ],
    });
    logger.info({ toolId: tool.id, toolName: tool.name }, 'Tool vector upserted to Qdrant');
  } catch (e) {
    throw new IndexerError({
      message: `Failed to upsert tool vector to Qdrant for ${tool.name}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

/**
 * Upsert multiple ToolNodes and their vector embeddings into Qdrant in batches
 * of up to BATCH_SIZE (100) items per HTTP request.
 *
 * Items with bad/missing embeddings fall back to a zero vector so the payload
 * is still stored and BM25 search works. Bad data in one item will not prevent
 * the rest of the batch from being attempted — a warning is logged instead.
 */
export async function upsertToolVectorBatch(
  tools: Array<{ tool: ToolNode; vector: number[] }>,
): Promise<void> {
  if (tools.length === 0) {
    logger.info('upsertToolVectorBatch called with empty array — nothing to do');
    return;
  }

  // Build Qdrant points, applying safe-vector fallback per item.
  const points = tools.map(({ tool, vector }) => {
    let safeVector: number[];
    if (vector.length === VECTOR_SIZE) {
      safeVector = vector;
    } else {
      logger.warn(
        { toolId: tool.id, toolName: tool.name, vecLen: vector.length },
        'Embedding missing or wrong size — using zero vector (BM25 only)',
      );
      safeVector = new Array(VECTOR_SIZE).fill(0);
    }
    return {
      id: tool.id,
      vector: safeVector,
      payload: tool as unknown as Record<string, unknown>,
    };
  });

  // Split into chunks of BATCH_SIZE and upsert each chunk.
  const client = qdrantClient();
  let successCount = 0;
  let failureCount = 0;

  for (let offset = 0; offset < points.length; offset += BATCH_SIZE) {
    const chunk = points.slice(offset, offset + BATCH_SIZE);
    try {
      await client.upsert(COLLECTION_NAME, { wait: true, points: chunk });
      successCount += chunk.length;
      logger.info(
        { batchOffset: offset, batchSize: chunk.length, totalTools: tools.length },
        'Batch upserted to Qdrant',
      );
    } catch (e) {
      failureCount += chunk.length;
      logger.error(
        {
          batchOffset: offset,
          batchSize: chunk.length,
          error: e instanceof Error ? e.message : String(e),
        },
        'Batch upsert to Qdrant failed — skipping chunk',
      );
    }
  }

  logger.info(
    { totalTools: tools.length, successCount, failureCount },
    'upsertToolVectorBatch complete',
  );

  if (failureCount > 0) {
    throw new IndexerError({
      message: `upsertToolVectorBatch: ${failureCount} of ${tools.length} tools failed to upsert`,
    });
  }
}

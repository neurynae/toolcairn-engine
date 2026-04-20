import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { IndexerError } from '../errors.js';

const logger = createLogger({ name: '@toolcairn/indexer:qdrant-writer' });

const VECTOR_SIZE = 768;

const BATCH_SIZE = 100;

/**
 * Fields that live in the Qdrant payload but are NOT part of the ToolNode
 * that the indexer builds — they're set by out-of-band scripts (upload-keywords)
 * and MUST be preserved across every reindex. A blind upsert would wipe them.
 */
const PRESERVED_PAYLOAD_FIELDS = ['keyword_sentence'] as const;

/**
 * Fetch the existing payload for `id` from Qdrant and return an object
 * containing only the fields we preserve across reindex. Empty object if
 * no prior point exists or on error — preservation is best-effort.
 */
async function fetchPreservedPayload(id: string): Promise<Record<string, unknown>> {
  try {
    const client = qdrantClient();
    const res = await client.retrieve(COLLECTION_NAME, {
      ids: [id],
      with_payload: [...PRESERVED_PAYLOAD_FIELDS],
      with_vector: false,
    });
    const pl = res[0]?.payload ?? {};
    const preserved: Record<string, unknown> = {};
    for (const key of PRESERVED_PAYLOAD_FIELDS) {
      if (pl[key] !== undefined && pl[key] !== null && pl[key] !== '') preserved[key] = pl[key];
    }
    return preserved;
  } catch {
    return {};
  }
}

/** Same, batched — fetches all ids in one retrieve call to keep latency bounded. */
async function fetchPreservedPayloadsBatch(
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (!ids.length) return new Map();
  try {
    const client = qdrantClient();
    const res = await client.retrieve(COLLECTION_NAME, {
      ids,
      with_payload: [...PRESERVED_PAYLOAD_FIELDS],
      with_vector: false,
    });
    const out = new Map<string, Record<string, unknown>>();
    for (const pt of res) {
      const preserved: Record<string, unknown> = {};
      for (const key of PRESERVED_PAYLOAD_FIELDS) {
        const v = pt.payload?.[key];
        if (v !== undefined && v !== null && v !== '') preserved[key] = v;
      }
      if (Object.keys(preserved).length) out.set(String(pt.id), preserved);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Upsert a ToolNode and its vector embedding into Qdrant.
 * When no NOMIC_API_KEY is available, the embedding will be empty ([]).
 * In that case we fall back to a zero vector so the payload is still stored
 * and BM25 keyword search works — vector similarity will return 0.0 for all.
 *
 * PRESERVED_PAYLOAD_FIELDS (keyword_sentence) are fetched from the existing
 * point before upsert and re-merged into the new payload, because they're
 * set by out-of-band scripts and would otherwise be wiped every reindex.
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
    const preserved = await fetchPreservedPayload(tool.id);
    const mergedPayload: Record<string, unknown> = {
      ...preserved,
      ...(tool as unknown as Record<string, unknown>),
    };
    // Re-assert preserved fields in case ToolNode has an explicit undefined
    // for the key (which would have overwritten via spread).
    for (const key of PRESERVED_PAYLOAD_FIELDS) {
      if (preserved[key] !== undefined) mergedPayload[key] = preserved[key];
    }
    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: tool.id,
          vector: safeVector,
          payload: mergedPayload,
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

  // Preserve out-of-band payload fields (keyword_sentence etc.) across reindex.
  const preservedById = await fetchPreservedPayloadsBatch(tools.map((t) => t.tool.id));

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
    const preserved = preservedById.get(tool.id) ?? {};
    const mergedPayload: Record<string, unknown> = {
      ...preserved,
      ...(tool as unknown as Record<string, unknown>),
    };
    for (const key of PRESERVED_PAYLOAD_FIELDS) {
      if (preserved[key] !== undefined) mergedPayload[key] = preserved[key];
    }
    return {
      id: tool.id,
      vector: safeVector,
      payload: mergedPayload,
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

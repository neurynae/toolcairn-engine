import type { ToolNode } from '@toolcairn/core';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import pino from 'pino';
import { IndexerError } from '../errors.js';

const logger = pino({ name: '@toolcairn/indexer:qdrant-writer' });

const VECTOR_SIZE = 768;

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
    throw new IndexerError(
      `Failed to upsert tool vector to Qdrant for ${tool.name}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

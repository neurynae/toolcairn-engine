import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { embedBatch, toolEmbedText } from '@toolcairn/vector';
import { IndexerError } from '../errors.js';

const logger = createLogger({ name: '@toolcairn/indexer:embedding-processor' });

/**
 * Generate a vector embedding for a ToolNode using the canonical embed text format.
 */
export async function generateEmbedding(tool: ToolNode): Promise<number[]> {
  try {
    const text = toolEmbedText(tool.name, tool.description, tool.topics, tool.keyword_sentence);
    logger.debug({ toolName: tool.name }, 'Generating embedding');

    const vectors = await embedBatch([text]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      throw new IndexerError({ message: `embedBatch returned no vector for tool: ${tool.name}` });
    }

    return vector;
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Failed to generate embedding for tool ${tool.name}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

/**
 * Generate vector embeddings for multiple ToolNodes in a single batched Nomic API call.
 * Returns an array of vectors in the same order as the input nodes.
 * Falls back to an array of zero-vectors if the API is unavailable.
 */
export async function generateEmbeddingBatch(nodes: ToolNode[]): Promise<number[][]> {
  if (nodes.length === 0) return [];

  const texts = nodes.map((node) =>
    toolEmbedText(node.name, node.description, node.topics, node.keyword_sentence),
  );
  logger.debug({ count: nodes.length }, 'Generating batch embeddings');

  try {
    const vectors = await embedBatch(texts);
    return vectors;
  } catch (e) {
    logger.warn(
      { count: nodes.length, error: e instanceof Error ? e.message : String(e) },
      'embedBatch failed — returning zero-vectors for batch',
    );
    // Graceful degradation: return zero-vectors so callers can continue without embeddings
    return nodes.map(() => new Array(768).fill(0) as number[]);
  }
}

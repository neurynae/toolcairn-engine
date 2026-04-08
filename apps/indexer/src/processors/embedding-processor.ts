import type { ToolNode } from '@toolcairn/core';
import { embedBatch, toolEmbedText } from '@toolcairn/vector';
import pino from 'pino';
import { IndexerError } from '../errors.js';

const logger = pino({ name: '@toolcairn/indexer:embedding-processor' });

/**
 * Generate a vector embedding for a ToolNode using the canonical embed text format.
 */
export async function generateEmbedding(tool: ToolNode): Promise<number[]> {
  try {
    const text = toolEmbedText(tool.name, tool.description, tool.topics);
    logger.debug({ toolName: tool.name }, 'Generating embedding');

    const vectors = await embedBatch([text]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      throw new IndexerError(`embedBatch returned no vector for tool: ${tool.name}`);
    }

    return vector;
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Failed to generate embedding for tool ${tool.name}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

import { createHash } from 'node:crypto';
import type { EdgeSource, EdgeType, ToolNode } from '@toolcairn/core';
import { MemgraphToolRepository, MemgraphUseCaseRepository } from '@toolcairn/graph';
import pino from 'pino';
import { IndexerError } from '../errors.js';
import type { TopicEdge } from '../types.js';

const logger = pino({ name: '@toolcairn/indexer:memgraph-writer' });

let _repository: MemgraphToolRepository | undefined;

function getRepository(): MemgraphToolRepository {
  if (!_repository) {
    _repository = new MemgraphToolRepository();
  }
  return _repository;
}

/**
 * Write or update a ToolNode in Memgraph.
 * Uses createTool which will upsert via the repository.
 */
export async function writeToolToMemgraph(tool: ToolNode): Promise<void> {
  const repo = getRepository();
  try {
    const result = await repo.createTool(tool);
    if (!result.ok) {
      throw new IndexerError(
        `Failed to write tool to Memgraph: ${result.error.message} (code: ${result.error.code})`,
      );
    }
    logger.info({ toolId: tool.id, toolName: tool.name }, 'Tool written to Memgraph');
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Unexpected error writing tool to Memgraph: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * Write a directed edge between two tools in Memgraph.
 * Looks up the target tool by name to get its ID, then upserts the edge.
 */
export async function writeEdgeToMemgraph(
  sourceId: string,
  targetName: string,
  edgeType: string,
  weight: number,
  confidence: number,
  source: string,
  decayRate: number,
): Promise<void> {
  const repo = getRepository();

  try {
    // Look up the target tool by name
    const findResult = await repo.findByName(targetName);
    if (!findResult.ok) {
      logger.warn(
        { targetName, error: findResult.error.message },
        'Could not look up target tool by name, skipping edge',
      );
      return;
    }

    if (!findResult.data) {
      logger.debug({ targetName }, 'Target tool not found in Memgraph, skipping edge');
      return;
    }

    const targetId = findResult.data.id;
    const now = new Date().toISOString();

    // Validate edge type
    const validEdgeTypes: EdgeType[] = [
      'SOLVES',
      'REQUIRES',
      'INTEGRATES_WITH',
      'REPLACES',
      'CONFLICTS_WITH',
      'POPULAR_WITH',
      'BREAKS_FROM',
      'HAS_VERSION',
      'COMPATIBLE_WITH',
    ];

    const resolvedEdgeType: EdgeType = validEdgeTypes.includes(edgeType as EdgeType)
      ? (edgeType as EdgeType)
      : 'INTEGRATES_WITH';

    // Validate edge source
    const validEdgeSources: EdgeSource[] = [
      'usage_data',
      'ai_generated',
      'github_signal',
      'manual',
      'co_occurrence',
      'changelog',
      'declared_dependency',
    ];

    const resolvedSource: EdgeSource = validEdgeSources.includes(source as EdgeSource)
      ? (source as EdgeSource)
      : 'github_signal';

    const upsertResult = await repo.upsertEdge({
      type: resolvedEdgeType,
      source_id: sourceId,
      target_id: targetId,
      properties: {
        weight,
        confidence,
        last_verified: now,
        source: resolvedSource,
        decay_rate: decayRate,
      },
    });

    if (!upsertResult.ok) {
      throw new IndexerError(
        `Failed to upsert edge: ${upsertResult.error.message} (code: ${upsertResult.error.code})`,
      );
    }

    logger.info(
      { sourceId, targetId, targetName, edgeType: resolvedEdgeType },
      'Edge written to Memgraph',
    );
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Unexpected error writing edge to Memgraph: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

function topicNodeId(nodeName: string): string {
  const hash = createHash('sha256').update(nodeName).digest('hex');
  return `topic-${hash.slice(0, 16)}`;
}

/**
 * Write UseCase/Pattern/Stack concept nodes and their typed edges to Memgraph.
 * Failures are non-fatal — logged and skipped to avoid blocking the main index pipeline.
 */
export async function writeTopicNodes(toolId: string, topicEdges: TopicEdge[]): Promise<void> {
  if (topicEdges.length === 0) return;
  const repo = new MemgraphUseCaseRepository();
  const now = new Date().toISOString();

  for (const edge of topicEdges) {
    try {
      // 1. Ensure the concept node exists
      await repo.mergeTopicNode({
        id: topicNodeId(edge.nodeName),
        name: edge.nodeName,
        description: `${edge.nodeType}: ${edge.nodeName.replace(/-/g, ' ')}`,
        node_type: edge.nodeType,
        created_at: now,
        updated_at: now,
      });

      // 2. Create the typed edge
      await repo.upsertTopicEdge({
        tool_id: toolId,
        node_name: edge.nodeName,
        node_type: edge.nodeType,
        weight: edge.weight,
        confidence: edge.confidence,
        last_verified: now,
        source: edge.source,
        decay_rate: edge.decayRate,
      });
    } catch (e) {
      logger.warn(
        { toolId, nodeName: edge.nodeName, err: e },
        'Topic node write failed (non-fatal)',
      );
    }
  }
}

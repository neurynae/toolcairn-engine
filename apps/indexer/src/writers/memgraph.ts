import { createHash } from 'node:crypto';
import type { EdgeSource, EdgeType, ToolNode, VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository, MemgraphUseCaseRepository } from '@toolcairn/graph';
import { buildVersionId } from '../crawlers/version-extractors/index.js';
import { IndexerError } from '../errors.js';
import type { TopicEdge } from '../types.js';

const logger = createLogger({ name: '@toolcairn/indexer:memgraph-writer' });

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
      throw new IndexerError({
        message: `Failed to write tool to Memgraph: ${result.error.message} (code: ${result.error.code})`,
      });
    }
    logger.info({ toolId: tool.id, toolName: tool.name }, 'Tool written to Memgraph');
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Unexpected error writing tool to Memgraph: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
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
      'VERSION_COMPATIBLE_WITH',
      'REQUIRES_RUNTIME',
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
      'deps_dev',
      'version_only',
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
      throw new IndexerError({
        message: `Failed to upsert edge: ${upsertResult.error.message} (code: ${upsertResult.error.code})`,
      });
    }

    logger.info(
      { sourceId, targetId, targetName, edgeType: resolvedEdgeType },
      'Edge written to Memgraph',
    );
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Unexpected error writing edge to Memgraph: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
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

/**
 * Persist a VersionNode + HAS_VERSION edge + per-peer/engine Version→Tool edges.
 *
 * Strategy:
 * 1. Upsert the VersionNode (deterministic id, MERGE-safe).
 * 2. Link Tool→Version via HAS_VERSION and mark as is_latest=true (clearing
 *    is_latest on any prior latest version of the same tool).
 * 3. For each peer/dep whose target Tool exists in the graph, write a
 *    VERSION_COMPATIBLE_WITH edge. Unresolved peers remain on
 *    VersionNode.peer_ranges_json (already persisted in step 1) — they'll
 *    resolve on a future reindex once the target Tool is indexed.
 * 4. For each engine constraint, write REQUIRES_RUNTIME to the canonical
 *    runtime Tool (e.g. node, python). Runtime Tools are seeded once via
 *    scripts/seed-runtime-tools.ts.
 *
 * All failures are logged but non-fatal — version writes must never block
 * the main tool-index pipeline.
 */
export async function writeVersionToMemgraph(
  toolName: string,
  toolId: string,
  meta: VersionMetadata,
): Promise<void> {
  const repo = getRepository();
  const versionId = buildVersionId(meta.registry, meta.packageName, meta.version);
  const now = new Date().toISOString();

  // Build peer_ranges + engines maps for storage on the node.
  const peerRanges: Record<string, string> = {};
  for (const p of meta.peers) peerRanges[p.packageName] = p.range;
  const engines: Record<string, string> = {};
  for (const e of meta.engines) engines[e.runtime] = e.range;

  try {
    const upsert = await repo.upsertVersion({
      id: versionId,
      tool_id: toolId,
      version: meta.version,
      registry: meta.registry,
      package_name: meta.packageName,
      release_date: meta.releaseDate ?? '',
      is_stable: meta.isStable,
      is_latest: true,
      deprecated: meta.deprecated ?? false,
      peer_ranges: peerRanges,
      engines,
      source: meta.source,
    });
    if (!upsert.ok) {
      logger.warn(
        { toolName, versionId, err: upsert.error.message },
        'upsertVersion failed (non-fatal)',
      );
      return;
    }

    const link = await repo.linkToolVersion(toolName, versionId, true);
    if (!link.ok) {
      logger.warn(
        { toolName, versionId, err: link.error.message },
        'linkToolVersion failed (non-fatal)',
      );
      return;
    }

    // Resolve peer edges only for already-indexed Tools.
    for (const peer of meta.peers) {
      const target = await repo.findByName(peer.packageName);
      if (!target.ok || !target.data) {
        logger.debug(
          { toolName, peer: peer.packageName },
          'Peer target not in graph — stored as peer_ranges_json only',
        );
        continue;
      }
      const edgeResult = await repo.upsertVersionEdge({
        source_version_id: versionId,
        target_tool_name: peer.packageName,
        edge_type: 'VERSION_COMPATIBLE_WITH',
        range: peer.range,
        range_system: peer.rangeSystem,
        kind: peer.kind,
        source: meta.source,
        confidence: meta.source === 'declared_dependency' ? 0.95 : 0.8,
        last_verified: now,
      });
      if (!edgeResult.ok) {
        logger.warn(
          { toolName, peer: peer.packageName, err: edgeResult.error.message },
          'upsertVersionEdge (peer) failed (non-fatal)',
        );
      }
    }

    // Runtime edges — requires runtime Tools to be seeded.
    for (const eng of meta.engines) {
      const target = await repo.findByName(eng.runtime);
      if (!target.ok || !target.data) {
        logger.debug(
          { toolName, runtime: eng.runtime },
          'Runtime Tool not seeded — REQUIRES_RUNTIME edge skipped',
        );
        continue;
      }
      const edgeResult = await repo.upsertVersionEdge({
        source_version_id: versionId,
        target_tool_name: eng.runtime,
        edge_type: 'REQUIRES_RUNTIME',
        range: eng.range,
        range_system: eng.rangeSystem,
        kind: 'dep',
        source: meta.source,
        confidence: 0.95,
        last_verified: now,
      });
      if (!edgeResult.ok) {
        logger.warn(
          { toolName, runtime: eng.runtime, err: edgeResult.error.message },
          'upsertVersionEdge (runtime) failed (non-fatal)',
        );
      }
    }

    logger.info(
      {
        toolName,
        versionId,
        peers: meta.peers.length,
        engines: meta.engines.length,
        source: meta.source,
      },
      'Version written to Memgraph',
    );
  } catch (e) {
    logger.warn(
      { toolName, versionId, err: e },
      'Version write threw — non-fatal, continuing index pipeline',
    );
  }
}

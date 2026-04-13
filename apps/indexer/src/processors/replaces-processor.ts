/**
 * Incremental REPLACES edge computation for newly indexed tools.
 *
 * When a tool is indexed, this runs after the Qdrant upsert to find
 * semantically similar tools (via recommend()) and create REPLACES edges.
 * Uses the same three guards as the batch migration:
 *
 *   Guard 4: name-derivative — TcUnit-Runner REPLACES TcUnit is wrong
 *   Guard 2: INTEGRATES_WITH — complement ≠ alternative
 *   Guard 3: REQUIRES — dependency ≠ alternative
 *
 * Fire-and-forget: errors are logged but never propagate to the main pipeline.
 */

import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:replaces-processor' });

const SIMILARITY_THRESHOLD = 0.82;
const RECOMMEND_LIMIT = 15;
const EDGE_WEIGHT_SCALE = 0.8;
const DECAY_RATE = 0.003;

// ─── Guard: name-derivative ──────────────────────────────────────────────────

function isNameDerivative(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb) || lb.includes(la);
}

// ─── Guard: structural relationship (INTEGRATES_WITH or REQUIRES) ───────────

async function hasStructuralRelationship(
  // biome-ignore lint/suspicious/noExplicitAny: session type not directly importable
  session: any,
  nameA: string,
  nameB: string,
): Promise<boolean> {
  try {
    const result = await session.run(
      `MATCH (a:Tool {name: $name_a}), (b:Tool {name: $name_b})
       RETURN EXISTS((a)-[:INTEGRATES_WITH]-(b)) AS has_integration,
              EXISTS((a)-[:REQUIRES]-(b)) AS has_requires,
              EXISTS((a)-[:REPLACES]-(b)) AS has_replaces`,
      { name_a: nameA, name_b: nameB },
    );
    const record = result.records[0];
    if (!record) return false;
    return (
      record.get('has_integration') === true ||
      record.get('has_requires') === true ||
      record.get('has_replaces') === true
    );
  } catch {
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Compute REPLACES edges for a single newly-indexed tool.
 * Called after the tool is written to Qdrant and Memgraph.
 */
export async function computeReplacesForTool(toolId: string, toolName: string): Promise<void> {
  // 1. Find similar tools via Qdrant recommend()
  let similar: Array<{ id: string; name: string; score: number }>;
  try {
    const results = await qdrantClient().recommend(COLLECTION_NAME, {
      positive: [toolId],
      limit: RECOMMEND_LIMIT,
      with_payload: { include: ['name', 'id'] },
    });

    similar = results
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .map((r) => ({
        id: String((r.payload as Record<string, unknown>)?.id ?? r.id),
        name: String((r.payload as Record<string, unknown>)?.name ?? ''),
        score: r.score,
      }));
  } catch (e) {
    logger.warn({ toolId, toolName, err: e }, 'recommend() failed for incremental REPLACES');
    return;
  }

  if (similar.length === 0) return;

  const repo = new MemgraphToolRepository();
  const { getMemgraphSession } = await import('@toolcairn/graph');
  const session = getMemgraphSession();

  let edgesCreated = 0;
  let skippedDerivative = 0;
  let skippedStructural = 0;

  try {
    for (const neighbor of similar) {
      if (neighbor.name === toolName || !neighbor.name) continue;

      // Guard 4: derivative/variant — fast in-process check
      if (isNameDerivative(toolName, neighbor.name)) {
        skippedDerivative++;
        continue;
      }

      // Guards 2+3: structural relationship — single Cypher query
      const hasRelationship = await hasStructuralRelationship(session, toolName, neighbor.name);
      if (hasRelationship) {
        skippedStructural++;
        continue;
      }

      const weight = Math.round(neighbor.score * EDGE_WEIGHT_SCALE * 1000) / 1000;
      const upsertResult = await repo.upsertEdge({
        type: 'REPLACES',
        source_id: toolId,
        target_id: neighbor.id,
        properties: {
          weight,
          confidence: 0.7,
          last_verified: new Date().toISOString(),
          source: 'vector_similarity',
          decay_rate: DECAY_RATE,
        },
      });

      if (upsertResult.ok) {
        edgesCreated++;
      } else {
        logger.warn(
          { toolName, target: neighbor.name, error: upsertResult.error },
          'Failed to upsert incremental REPLACES edge',
        );
      }
    }

    if (edgesCreated > 0 || skippedDerivative > 0 || skippedStructural > 0) {
      logger.info(
        { toolName, edgesCreated, skippedDerivative, skippedStructural },
        'Incremental REPLACES edges computed',
      );
    }
  } finally {
    await session.close();
  }
}

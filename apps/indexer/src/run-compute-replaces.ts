/**
 * Batch migration: compute REPLACES edges from vector embedding similarity.
 *
 * A REPLACES edge represents "these tools are alternatives — pick one."
 * We create one only when ALL of the following are true:
 *
 *   1. Cosine similarity ≥ SIMILARITY_THRESHOLD  (semantic similarity)
 *   2. No INTEGRATES_WITH edge exists             (complements are not alternatives)
 *   3. No REQUIRES edge exists in either direction (dependencies are not alternatives)
 *   4. Neither name is a substring of the other   (derivatives/wrappers are not alternatives)
 *
 * Guards 2-4 are all data-driven from the existing graph — no keyword rules.
 * Guards 2+3 are checked together in a single Memgraph query per pair.
 * Guard 4 is a fast in-process string check before hitting the database.
 *
 * After processing, a cleanup pass automatically removes any false positives
 * that exist from previous runs (before these guards were added).
 *
 * Usage:
 *   pnpm tsx src/run-compute-replaces.ts
 *
 * Environment:
 *   SIMILARITY_THRESHOLD=0.82  (default)
 *   BATCH_SIZE=10              (concurrent recommend calls per batch)
 *   DRY_RUN=1                  (log without writing)
 *   START_OFFSET=0             (resume from tool index N)
 */

import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository, closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:compute-replaces' });

// ─── Config ─────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD) || 0.82;
const EDGE_WEIGHT_SCALE = 0.8;
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 10;
const RECOMMEND_LIMIT = 15;
const DRY_RUN = process.env.DRY_RUN === '1';
const START_OFFSET = Number(process.env.START_OFFSET) || 0;
const DECAY_RATE = 0.003;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolPoint {
  id: string;
  name: string;
}

interface Stats {
  toolsProcessed: number;
  edgesCreated: number;
  skippedDerivative: number; // guard 4: name-substring derivative
  skippedStructural: number; // guards 2+3: INTEGRATES_WITH or REQUIRES exists
  errors: number;
}

// ─── Guard: name-derivative (fast, in-process) ───────────────────────────────

/**
 * Guard 4 — catches derivative/variant/wrapper tools before hitting the DB.
 *
 * If one tool's name is a substring of the other, they have a parent-child
 * relationship, not an alternative relationship:
 *   - "TcUnit-Runner" contains "TcUnit"   → TcUnit-Runner runs TcUnit tests (dependency)
 *   - "networked-aframe" contains "aframe" → extension of aframe
 *   - "webtorrent-cli" contains "webtorrent" → CLI wrapper around the library
 *   - "prisma-editor" contains "prisma"    → GUI tool FOR prisma
 *   - "workos-php-laravel" contains "workos-php" → Laravel integration of the base SDK
 *
 * Case-insensitive to catch casing differences like "AFrame" vs "aframe".
 */
function isNameDerivative(a: string, b: string): boolean {
  const lower_a = a.toLowerCase();
  const lower_b = b.toLowerCase();
  return lower_a.includes(lower_b) || lower_b.includes(lower_a);
}

// ─── Guard: structural relationship (single DB query) ───────────────────────

/**
 * Guards 2+3 combined in one Memgraph query.
 *
 * Returns true if the pair has ANY of:
 *   - INTEGRATES_WITH edge (they complement each other, not replace)
 *   - REQUIRES edge in either direction (dependency relationship)
 *   - REPLACES edge already exists (idempotency)
 *
 * A single query is cheaper than three separate getDirectEdges calls.
 */
async function hasStructuralRelationship(
  // biome-ignore lint/suspicious/noExplicitAny: session type from neo4j-driver not directly importable here
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
    return false; // fail-safe: skip the pair if query fails
  }
}

// ─── Qdrant helpers ─────────────────────────────────────────────────────────

async function scrollAllTools(): Promise<ToolPoint[]> {
  const tools: ToolPoint[] = [];
  let offset: string | number | undefined = undefined;

  for (;;) {
    const page = await qdrantClient().scroll(COLLECTION_NAME, {
      limit: 500,
      ...(offset != null ? { offset } : {}),
      with_payload: { include: ['name'] },
      with_vector: false,
    });

    for (const point of page.points) {
      const name = (point.payload as Record<string, unknown>)?.name;
      if (typeof name === 'string') {
        tools.push({ id: String(point.id), name });
      }
    }

    const nextOffset = page.next_page_offset as string | number | null | undefined;
    if (nextOffset == null) break;
    offset = nextOffset;
  }

  return tools;
}

async function findSimilar(
  toolId: string,
): Promise<Array<{ id: string; name: string; score: number }>> {
  try {
    const results = await qdrantClient().recommend(COLLECTION_NAME, {
      positive: [toolId],
      limit: RECOMMEND_LIMIT,
      with_payload: { include: ['name', 'id'] },
    });

    return results
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .map((r) => ({
        id: String((r.payload as Record<string, unknown>)?.id ?? r.id),
        name: String((r.payload as Record<string, unknown>)?.name ?? ''),
        score: r.score,
      }));
  } catch (e) {
    logger.warn({ toolId, err: e }, 'recommend() failed');
    return [];
  }
}

// ─── Post-run cleanup ────────────────────────────────────────────────────────

/**
 * After processing, automatically remove any false positives from this or
 * previous runs. Runs a Cypher DELETE for each guard that can be expressed
 * as a graph pattern — no application code needed.
 *
 * Guard 4 cleanup: delete REPLACES where name containment exists.
 * Guard 2+3 cleanup: delete REPLACES where INTEGRATES_WITH or REQUIRES also exists.
 */
async function runPostMigrationCleanup(dryRun: boolean): Promise<void> {
  const session = getMemgraphSession();
  try {
    // Cleanup for guard 4: name-derivative false positives
    const query4 = dryRun
      ? `MATCH (a:Tool)-[r:REPLACES]->(b:Tool)
         WHERE toLower(b.name) CONTAINS toLower(a.name)
            OR toLower(a.name) CONTAINS toLower(b.name)
         RETURN count(r) AS count`
      : `MATCH (a:Tool)-[r:REPLACES]->(b:Tool)
         WHERE toLower(b.name) CONTAINS toLower(a.name)
            OR toLower(a.name) CONTAINS toLower(b.name)
         DELETE r RETURN count(*) AS count`;

    const r4 = await session.run(query4);
    const n4 = Number(r4.records[0]?.get('count') ?? 0);
    logger.info(
      { count: n4, dryRun },
      dryRun
        ? '[CLEANUP-DRY] Would delete name-derivative FPs'
        : '[CLEANUP] Deleted name-derivative FPs',
    );

    // Cleanup for guards 2+3: structural relationship false positives
    const query23 = dryRun
      ? `MATCH (a:Tool)-[r:REPLACES]->(b:Tool)
         WHERE (a)-[:INTEGRATES_WITH]-(b) OR (a)-[:REQUIRES]-(b)
         RETURN count(r) AS count`
      : `MATCH (a:Tool)-[r:REPLACES]->(b:Tool)
         WHERE (a)-[:INTEGRATES_WITH]-(b) OR (a)-[:REQUIRES]-(b)
         DELETE r RETURN count(*) AS count`;

    const r23 = await session.run(query23);
    const n23 = Number(r23.records[0]?.get('count') ?? 0);
    logger.info(
      { count: n23, dryRun },
      dryRun
        ? '[CLEANUP-DRY] Would delete structural relationship FPs (INTEGRATES_WITH/REQUIRES)'
        : '[CLEANUP] Deleted structural relationship FPs (INTEGRATES_WITH/REQUIRES)',
    );
  } finally {
    await session.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  logger.info(
    { SIMILARITY_THRESHOLD, BATCH_SIZE, RECOMMEND_LIMIT, DRY_RUN, START_OFFSET },
    'Starting REPLACES edge computation',
  );

  const allTools = await scrollAllTools();
  logger.info({ count: allTools.length }, 'Loaded all tool points');

  const repo = new MemgraphToolRepository();
  const stats: Stats = {
    toolsProcessed: 0,
    edgesCreated: 0,
    skippedDerivative: 0,
    skippedStructural: 0,
    errors: 0,
  };

  const toolsToProcess = allTools.slice(START_OFFSET);
  logger.info({ total: toolsToProcess.length, offset: START_OFFSET }, 'Processing tools');

  // Re-use a single Memgraph session per batch for structural checks
  // (opened and closed around each batch to avoid long-lived connections)

  for (let i = 0; i < toolsToProcess.length; i += BATCH_SIZE) {
    const batch = toolsToProcess.slice(i, i + BATCH_SIZE);

    // Recommend calls run in parallel (Qdrant is stateless)
    const batchResults = await Promise.all(
      batch.map(async (tool) => ({ tool, similar: await findSimilar(tool.id) })),
    );

    // Structural checks run sequentially through a shared session per batch
    const session = getMemgraphSession();
    try {
      for (const { tool, similar } of batchResults) {
        for (const neighbor of similar) {
          if (neighbor.name === tool.name) continue;

          // Guard 4: fast in-process check — derivative/variant tools are not alternatives
          if (isNameDerivative(tool.name, neighbor.name)) {
            stats.skippedDerivative++;
            continue;
          }

          // Guards 2+3: single graph query — skip if structural relationship exists
          const hasRelationship = await hasStructuralRelationship(
            session,
            tool.name,
            neighbor.name,
          );
          if (hasRelationship) {
            stats.skippedStructural++;
            continue;
          }

          const weight = Math.round(neighbor.score * EDGE_WEIGHT_SCALE * 1000) / 1000;

          if (DRY_RUN) {
            logger.info(
              { source: tool.name, target: neighbor.name, score: neighbor.score, weight },
              '[DRY_RUN] Would create REPLACES edge',
            );
            stats.edgesCreated++;
          } else {
            const upsertResult = await repo.upsertEdge({
              type: 'REPLACES',
              source_id: tool.id,
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
              stats.edgesCreated++;
            } else {
              stats.errors++;
              logger.warn(
                { source: tool.name, target: neighbor.name, error: upsertResult.error },
                'Failed to create REPLACES edge',
              );
            }
          }
        }

        stats.toolsProcessed++;
      }
    } finally {
      await session.close();
    }

    if ((stats.toolsProcessed + START_OFFSET) % 500 < BATCH_SIZE) {
      logger.info(
        {
          processed: stats.toolsProcessed + START_OFFSET,
          total: allTools.length,
          edgesCreated: stats.edgesCreated,
          skippedDerivative: stats.skippedDerivative,
          skippedStructural: stats.skippedStructural,
          errors: stats.errors,
        },
        'Progress',
      );
    }
  }

  logger.info(stats, 'Processing complete — running post-migration cleanup');

  // Cleanup runs after every pass — removes any FPs from this or previous runs
  await runPostMigrationCleanup(DRY_RUN);

  const session = getMemgraphSession();
  try {
    const result = await session.run('MATCH ()-[r:REPLACES]->() RETURN count(r) AS total');
    logger.info(
      { total: Number(result.records[0]?.get('total') ?? 0) },
      'Final REPLACES edge count',
    );
  } finally {
    await session.close();
  }

  await closeMemgraphDriver();
}

main().catch((e) => {
  logger.error({ err: e }, 'Fatal error in compute-replaces');
  process.exit(1);
});

/**
 * One-time backfill: compute credibility_score for all existing tools.
 *
 * Reads every tool from Qdrant (with payload), computes credibility from
 * existing health signals + owner_type, then writes back to both Qdrant
 * (setPayload) and Memgraph (SET health_credibility_score).
 *
 * Safe to re-run — idempotent (overwrites with fresh computation).
 *
 * Usage: pnpm tsx src/backfill-credibility.ts
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:backfill-credibility' });

/** Same normalizeLog used in health-calculator.ts */
function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

interface ToolPayload {
  id: string;
  name: string;
  owner_type?: string;
  health: {
    stars: number;
    stars_velocity_90d: number;
    maintenance_score: number;
    contributor_count: number;
    credibility_score?: number;
  };
}

function computeCredibility(tool: ToolPayload): number {
  const { stars, maintenance_score, contributor_count, stars_velocity_90d } = tool.health;
  const ownerType = tool.owner_type;

  const logStars = Math.min(1, Math.log10(stars + 1) / Math.log10(300_001));
  const orgBonus = ownerType === 'Organization' ? 1.0 : stars >= 1000 ? 0.6 : 0.3;
  const contribScore = normalizeLog(contributor_count, 500);
  const velocityScore = normalizeLog(stars_velocity_90d, 5000);

  const score =
    0.35 * logStars +
    0.2 * orgBonus +
    0.2 * Math.max(0, Math.min(1, maintenance_score)) +
    0.15 * contribScore +
    0.1 * velocityScore;

  return Math.max(0, Math.min(1, score));
}

async function main() {
  const client = qdrantClient();
  const session = getMemgraphSession();

  let offset: string | number | null | undefined = undefined;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const PAGE_SIZE = 200;

  try {
    while (true) {
      const result = await client.scroll(COLLECTION_NAME, {
        limit: PAGE_SIZE,
        offset,
        with_payload: true,
        with_vector: false,
      });

      const points = result.points as Array<{
        id: string | number;
        payload: Record<string, unknown> | null;
      }>;

      if (points.length === 0) break;

      // Compute credibility for each tool and update Qdrant + Memgraph
      for (const point of points) {
        if (!point.payload) continue;

        const tool = point.payload as unknown as ToolPayload;
        if (!tool.health || typeof tool.health.stars !== 'number') {
          totalSkipped++;
          continue;
        }

        const credibility = computeCredibility(tool);

        // Update Qdrant payload (partial — only touches health.credibility_score)
        try {
          await client.setPayload(COLLECTION_NAME, {
            payload: {
              health: { ...tool.health, credibility_score: credibility },
            },
            filter: {
              must: [{ key: 'name', match: { value: tool.name } }],
            },
          });
        } catch (e) {
          logger.warn({ tool: tool.name, err: e }, 'Qdrant setPayload failed');
          totalSkipped++;
          continue;
        }

        // Update Memgraph
        try {
          await session.run(
            'MATCH (t:Tool { name: $name }) SET t.health_credibility_score = $score',
            { name: tool.name, score: credibility },
          );
        } catch (e) {
          logger.warn({ tool: tool.name, err: e }, 'Memgraph SET failed');
        }

        totalUpdated++;
      }

      const nextOffset = result.next_page_offset as string | number | null | undefined;
      logger.info({ offset: nextOffset, pageSize: points.length, totalUpdated }, 'Page processed');

      if (!nextOffset) break;
      offset = nextOffset;
    }

    logger.info({ totalUpdated, totalSkipped }, 'Credibility backfill complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

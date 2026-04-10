/**
 * One-time backfill: compute credibility_score for all existing tools.
 *
 * Reads every tool from Qdrant (with payload), computes credibility from
 * existing health signals + owner_type, then writes back to both:
 *   - Qdrant: update by point UUID (exact, no name-collision risk)
 *   - Memgraph: update by github_url (unique per tool, avoids name collisions)
 *
 * Safe to re-run — idempotent (overwrites with fresh computation).
 *
 * Usage: pnpm tsx src/backfill-credibility.ts
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:backfill-credibility' });

function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

interface ToolPayload {
  name: string;
  github_url: string;
  owner_type?: string;
  is_fork?: boolean;
  health: {
    stars: number;
    forks_count?: number;
    stars_velocity_30d?: number;
    maintenance_score: number;
    contributor_count: number;
    weekly_downloads?: number;
    credibility_score?: number;
  };
}

function computeCredibility(tool: ToolPayload): number {
  const { stars, maintenance_score, contributor_count } = tool.health;
  const forksCount = tool.health.forks_count ?? 0;
  const weeklyDownloads = tool.health.weekly_downloads ?? 0;
  const velocity30d = tool.health.stars_velocity_30d ?? 0;
  const ownerType = tool.owner_type;
  const isFork = tool.is_fork ?? false;

  const logStars = Math.min(1, Math.log10(stars + 1) / Math.log10(300_001));
  const forksScore = Math.min(1, Math.log10(forksCount + 1) / Math.log10(100_001));
  const orgBonus = ownerType === 'Organization' ? 1.0 : stars >= 1000 ? 0.6 : 0.3;
  const contribScore = normalizeLog(contributor_count, 500);
  const dlScore = normalizeLog(weeklyDownloads, 500_000);
  const velocity30dScore = normalizeLog(velocity30d, 5000);

  const raw =
    0.28 * logStars +
    0.18 * forksScore +
    0.15 * orgBonus +
    0.15 * Math.max(0, Math.min(1, maintenance_score)) +
    0.12 * dlScore +
    0.07 * contribScore +
    0.05 * velocity30dScore;

  const forkPenalty = isFork ? 0.4 : 1.0;
  return Math.max(0, Math.min(1, raw * forkPenalty));
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

      for (const point of points) {
        if (!point.payload) continue;

        const tool = point.payload as unknown as ToolPayload;
        if (!tool.health || typeof tool.health.stars !== 'number' || !tool.github_url) {
          totalSkipped++;
          continue;
        }

        const credibility = computeCredibility(tool);
        const pointId = String(point.id);

        // Update Qdrant by point UUID — avoids updating multiple tools that share a name
        try {
          await client.setPayload(COLLECTION_NAME, {
            payload: {
              health: { ...tool.health, credibility_score: credibility },
            },
            points: [pointId],
          });
        } catch (e) {
          logger.warn({ tool: tool.name, pointId, err: e }, 'Qdrant setPayload failed');
          totalSkipped++;
          continue;
        }

        // Update Memgraph by github_url — unique per tool, no name-collision risk
        try {
          await session.run(
            'MATCH (t:Tool { github_url: $url }) SET t.health_credibility_score = $score',
            { url: tool.github_url, score: credibility },
          );
        } catch (e) {
          logger.warn(
            { tool: tool.name, github_url: tool.github_url, err: e },
            'Memgraph SET failed',
          );
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

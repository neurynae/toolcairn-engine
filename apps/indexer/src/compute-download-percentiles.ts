import type { PackageChannel } from '@toolcairn/core';
import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { REGISTRY_CONFIGS } from './crawlers/registry-config.js';
import { computeCredibility } from './processors/health-calculator.js';

const logger = createLogger({ name: '@toolcairn/indexer:download-percentiles' });
const DRY_RUN = !process.argv.includes('--write');
const MIN_GROUP_SIZE = 50;

const DEFAULT_SCALE = 50_000;
function getLogScale(registry: string): number {
  return REGISTRY_CONFIGS[registry]?.logScale ?? DEFAULT_SCALE;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolDownloadData {
  pointId: string;
  name: string;
  githubUrl: string;
  channels: PackageChannel[];
  health: {
    stars: number;
    forks_count: number;
    maintenance_score: number;
    contributor_count: number;
    stars_velocity_30d: number;
    credibility_score: number;
  };
  ownerType: string | null;
  isFork: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

/** Build the signals object needed by computeCredibility from stored health data */
function toCredibilitySignals(tool: ToolDownloadData) {
  return {
    logStars: Math.min(1, Math.log10(tool.health.stars + 1) / Math.log10(300_001)),
    forksScore: Math.min(1, Math.log10((tool.health.forks_count ?? 0) + 1) / Math.log10(100_001)),
    orgBonus: tool.ownerType === 'Organization' ? 1.0 : tool.health.stars >= 1000 ? 0.6 : 0.3,
    contribScore: normalizeLog(tool.health.contributor_count, 500),
    velocity30dScore: normalizeLog(tool.health.stars_velocity_30d, 5000),
    maint: Math.max(0, Math.min(1, tool.health.maintenance_score)),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) logger.info('DRY RUN — pass --write to commit changes');

  const client = qdrantClient();
  let offset: string | number | null | undefined = undefined;
  const PAGE_SIZE = 500;

  // Phase 1: Collect all tools
  const allTools: ToolDownloadData[] = [];

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

    for (const point of points) {
      if (!point.payload) continue;
      const p = point.payload as Record<string, unknown>;
      const health = p.health as Record<string, unknown> | undefined;
      if (!health) continue;

      // Parse package_managers channels (stored as JSON string or array in Qdrant payload)
      let channels: PackageChannel[] = [];
      try {
        const raw = p.package_managers;
        if (typeof raw === 'string') {
          channels = JSON.parse(raw) as PackageChannel[];
        } else if (Array.isArray(raw)) {
          channels = raw as PackageChannel[];
        }
      } catch {
        channels = [];
      }

      allTools.push({
        pointId: String(point.id),
        name: p.name as string,
        githubUrl: p.github_url as string,
        channels,
        health: {
          stars: (health.stars as number) ?? 0,
          forks_count: (health.forks_count as number) ?? 0,
          maintenance_score: (health.maintenance_score as number) ?? 0,
          contributor_count: (health.contributor_count as number) ?? 0,
          stars_velocity_30d: (health.stars_velocity_30d as number) ?? 0,
          credibility_score: (health.credibility_score as number) ?? 0,
        },
        ownerType: (p.owner_type as string) ?? null,
        isFork: (p.is_fork as boolean) ?? false,
      });
    }

    const nextOffset = result.next_page_offset as string | number | null | undefined;
    if (!nextOffset) break;
    offset = nextOffset;
  }

  logger.info({ totalTools: allTools.length }, 'Scanned all tools');

  // Phase 2: Group by registry and compute percentiles per registry.
  // Each tool can appear in MULTIPLE registries — collect (toolId, weeklyDownloads)
  // pairs per registry, compute percentile rank within the registry group, then
  // assign each tool its MAX percentile across all its channels.

  // Collect per-registry entries: registry → [(pointId, weeklyDownloads)]
  const byRegistry = new Map<string, Array<{ pointId: string; weeklyDownloads: number }>>();

  for (const tool of allTools) {
    for (const ch of tool.channels) {
      if (ch.weeklyDownloads <= 0) continue;
      const group = byRegistry.get(ch.registry) ?? [];
      group.push({ pointId: tool.pointId, weeklyDownloads: ch.weeklyDownloads });
      byRegistry.set(ch.registry, group);
    }
  }

  logger.info(
    {
      registries: byRegistry.size,
      withChannels: allTools.filter((t) => t.channels.some((c) => c.weeklyDownloads > 0)).length,
    },
    'Download distribution',
  );

  // Compute dlScore per (toolId, registry) pair
  const dlScoreByToolRegistry = new Map<string, number>(); // key: `${pointId}:${registry}`

  for (const [registry, group] of byRegistry) {
    if (group.length >= MIN_GROUP_SIZE) {
      // Percentile-based: rank within registry
      group.sort((a, b) => a.weeklyDownloads - b.weeklyDownloads);
      for (let i = 0; i < group.length; i++) {
        const percentile = (i + 1) / group.length;
        dlScoreByToolRegistry.set(`${group[i]!.pointId}:${registry}`, percentile);
      }
      logger.info(
        { registry, count: group.length, method: 'percentile' },
        'Computed percentile scores',
      );
    } else {
      // Fallback: log normalization with registry-specific scale
      const scale = getLogScale(registry);
      for (const entry of group) {
        dlScoreByToolRegistry.set(
          `${entry.pointId}:${registry}`,
          normalizeLog(entry.weeklyDownloads, scale),
        );
      }
      logger.info(
        { registry, count: group.length, scale, method: 'log-scale' },
        'Computed log-scale scores (group too small for percentile)',
      );
    }
  }

  // For each tool: dlScore = MAX percentile across all its channels
  const dlScores = new Map<string, number>();
  for (const tool of allTools) {
    let maxScore = 0;
    for (const ch of tool.channels) {
      const score = dlScoreByToolRegistry.get(`${tool.pointId}:${ch.registry}`) ?? 0;
      if (score > maxScore) maxScore = score;
    }
    if (maxScore > 0) dlScores.set(tool.pointId, maxScore);
  }

  if (DRY_RUN) {
    // Show sample scores
    const samples = [...dlScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([id, score]) => {
        const tool = allTools.find((t) => t.pointId === id);
        const chSummary = tool?.channels
          .filter((c) => c.weeklyDownloads > 0)
          .map((c) => `${c.registry}:${c.weeklyDownloads}`)
          .join(', ');
        return `${tool?.name} [${chSummary}]: dlScore=${score.toFixed(3)}`;
      });
    logger.info({ samples }, 'Top dlScores');
    logger.info('Re-run with --write to commit');
    return;
  }

  // Phase 3: Recalculate credibility and write back
  const session = getMemgraphSession();
  let updated = 0;

  for (const tool of allTools) {
    const dlScore = dlScores.get(tool.pointId) ?? 0;
    const hasDownloads = dlScore > 0;
    const newCredibility = computeCredibility(
      toCredibilitySignals(tool),
      dlScore,
      hasDownloads,
      tool.isFork,
    );

    // Skip if credibility hasn't changed meaningfully
    if (Math.abs(newCredibility - tool.health.credibility_score) < 0.005) continue;

    try {
      await client.setPayload(COLLECTION_NAME, {
        payload: {
          health: {
            ...tool.health,
            credibility_score: newCredibility,
          },
        },
        points: [tool.pointId],
      });
    } catch (e) {
      logger.warn({ name: tool.name, err: e }, 'Qdrant update failed');
      continue;
    }

    try {
      await session.run(
        'MATCH (t:Tool { github_url: $url }) SET t.health_credibility_score = $cred',
        { url: tool.githubUrl, cred: newCredibility },
      );
    } catch (e) {
      logger.warn({ name: tool.name, err: e }, 'Memgraph update failed');
    }

    updated++;
    if (updated % 500 === 0) {
      logger.info({ updated, total: allTools.length }, 'Update progress');
    }
  }

  await session.close();
  await closeMemgraphDriver();

  // Phase 4: Compute and store 25th percentile thresholds per registry in AppSettings.
  // These are used by the index-consumer quality gate to allow low-star but
  // high-download tools: a tool qualifies if its downloads >= 25th percentile
  // of its registry (i.e. it has more downloads than at least 25% of indexed tools).
  const thresholds: Record<string, number> = {};
  for (const [registry, group] of byRegistry) {
    if (group.length >= MIN_GROUP_SIZE) {
      // Sort ascending and take the 25th percentile value
      const sorted = [...group].sort((a, b) => a.weeklyDownloads - b.weeklyDownloads);
      const idx = Math.floor(sorted.length * 0.25);
      thresholds[registry] = sorted[idx]?.weeklyDownloads ?? 0;
    }
  }

  if (Object.keys(thresholds).length > 0) {
    const prisma = new PrismaClient();
    try {
      await prisma.appSettings.upsert({
        where: { id: 'global' },
        create: { id: 'global', download_quality_thresholds: JSON.stringify(thresholds) },
        update: { download_quality_thresholds: JSON.stringify(thresholds) },
      });
      logger.info({ thresholds }, 'Download quality thresholds stored in AppSettings');
    } catch (e) {
      logger.warn({ err: e }, 'Failed to store download thresholds — non-fatal');
    } finally {
      await prisma.$disconnect();
    }
  }

  logger.info(
    { updated, totalTools: allTools.length, registries: byRegistry.size },
    'Percentile recalculation complete',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

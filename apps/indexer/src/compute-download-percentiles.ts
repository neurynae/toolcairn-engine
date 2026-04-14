import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:download-percentiles' });
const DRY_RUN = !process.argv.includes('--write');
const MIN_GROUP_SIZE = 50;

// ─── Fallback scales for small groups ───────────────────────────────────────
// Used when fewer than MIN_GROUP_SIZE tools exist for a registry.
// Values represent "very popular" weekly downloads in each ecosystem.

const REGISTRY_SCALES: Record<string, number> = {
  npm: 1_000_000,
  pypi: 1_000_000,
  crates: 100_000,
  rubygems: 50_000,
  packagist: 200_000,
  nuget: 500_000,
  pub: 50_000,
  hex: 10_000,
  cran: 50_000,
  docker: 100_000,
  homebrew: 10_000,
  terraform: 5_000,
  clojars: 10_000,
  dub: 5_000,
  ansible: 50_000,
  puppet: 10_000,
  chef: 10_000,
  flathub: 5_000,
  wordpress: 50_000,
  vscode: 100_000,
  julia: 10_000,
  cocoapods: 10_000,
};

const DEFAULT_SCALE = 50_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolDownloadData {
  pointId: string;
  name: string;
  githubUrl: string;
  weeklyDownloads: number;
  downloadRegistry: string | null;
  health: {
    stars: number;
    forks_count: number;
    maintenance_score: number;
    contributor_count: number;
    stars_velocity_30d: number;
    credibility_score: number;
    weekly_downloads: number;
  };
  ownerType: string | null;
  isFork: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

/**
 * Compute credibility with a provided dlScore (0-1).
 * Same formula as health-calculator.ts but accepts pre-computed dlScore.
 */
function computeCredibilityWithDlScore(
  tool: ToolDownloadData,
  dlScore: number,
  hasDownloads: boolean,
): number {
  const logStars = Math.min(1, Math.log10(tool.health.stars + 1) / Math.log10(300_001));
  const forksScore = Math.min(
    1,
    Math.log10((tool.health.forks_count ?? 0) + 1) / Math.log10(100_001),
  );
  const orgBonus = tool.ownerType === 'Organization' ? 1.0 : tool.health.stars >= 1000 ? 0.6 : 0.3;
  const contribScore = normalizeLog(tool.health.contributor_count, 500);
  const velocity30dScore = normalizeLog(tool.health.stars_velocity_30d, 5000);
  const maint = Math.max(0, Math.min(1, tool.health.maintenance_score));

  let raw: number;
  if (hasDownloads) {
    raw =
      0.28 * logStars +
      0.18 * forksScore +
      0.15 * orgBonus +
      0.15 * maint +
      0.12 * dlScore +
      0.07 * contribScore +
      0.05 * velocity30dScore;
  } else {
    raw =
      0.318 * logStars +
      0.205 * forksScore +
      0.17 * orgBonus +
      0.17 * maint +
      0.08 * contribScore +
      0.057 * velocity30dScore;
  }

  const forkPenalty = tool.isFork ? 0.4 : 1.0;
  return Math.max(0, Math.min(1, raw * forkPenalty));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) logger.info('DRY RUN — pass --write to commit changes');

  const client = qdrantClient();
  let offset: string | number | null | undefined = undefined;
  const PAGE_SIZE = 500;

  // Phase 1: Collect all tools with download data
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

      allTools.push({
        pointId: String(point.id),
        name: p.name as string,
        githubUrl: p.github_url as string,
        weeklyDownloads: (health.weekly_downloads as number) ?? 0,
        downloadRegistry: (health.download_registry as string) ?? null,
        health: {
          stars: (health.stars as number) ?? 0,
          forks_count: (health.forks_count as number) ?? 0,
          maintenance_score: (health.maintenance_score as number) ?? 0,
          contributor_count: (health.contributor_count as number) ?? 0,
          stars_velocity_30d: (health.stars_velocity_30d as number) ?? 0,
          credibility_score: (health.credibility_score as number) ?? 0,
          weekly_downloads: (health.weekly_downloads as number) ?? 0,
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

  // Phase 2: Group by registry and compute percentiles
  const withDownloads = allTools.filter((t) => t.weeklyDownloads > 0 && t.downloadRegistry);
  const withoutDownloads = allTools.filter((t) => t.weeklyDownloads <= 0 || !t.downloadRegistry);

  logger.info(
    { withDownloads: withDownloads.length, withoutDownloads: withoutDownloads.length },
    'Download distribution',
  );

  // Group by registry
  const byRegistry = new Map<string, ToolDownloadData[]>();
  for (const tool of withDownloads) {
    const reg = tool.downloadRegistry as string;
    const group = byRegistry.get(reg) ?? [];
    group.push(tool);
    byRegistry.set(reg, group);
  }

  // Compute dlScore per tool
  const dlScores = new Map<string, number>();

  for (const [registry, group] of byRegistry) {
    if (group.length >= MIN_GROUP_SIZE) {
      // Percentile-based: rank within registry
      group.sort((a, b) => a.weeklyDownloads - b.weeklyDownloads);
      for (let i = 0; i < group.length; i++) {
        const percentile = (i + 1) / group.length; // 0→1, higher = more downloads
        dlScores.set(group[i]!.pointId, percentile);
      }
      logger.info(
        { registry, count: group.length, method: 'percentile' },
        'Computed percentile scores',
      );
    } else {
      // Fallback: log normalization with registry-specific scale
      const scale = REGISTRY_SCALES[registry] ?? DEFAULT_SCALE;
      for (const tool of group) {
        dlScores.set(tool.pointId, normalizeLog(tool.weeklyDownloads, scale));
      }
      logger.info(
        { registry, count: group.length, scale, method: 'log-scale' },
        'Computed log-scale scores (group too small for percentile)',
      );
    }
  }

  if (DRY_RUN) {
    // Show sample scores
    const samples = [...dlScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([id, score]) => {
        const tool = allTools.find((t) => t.pointId === id);
        return `${tool?.name} (${tool?.downloadRegistry}): dl=${tool?.weeklyDownloads}/wk → dlScore=${score.toFixed(3)}`;
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
    const newCredibility = computeCredibilityWithDlScore(tool, dlScore, hasDownloads);

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

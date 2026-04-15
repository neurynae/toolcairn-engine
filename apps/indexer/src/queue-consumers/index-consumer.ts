import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { runCrawler } from '../crawlers/index.js';
import { REGISTRY_CONFIGS } from '../crawlers/registry-config.js';
import { processTool } from '../processors/index.js';
import { writeEdgeToMemgraph, writeToolToMemgraph, writeTopicNodes } from '../writers/memgraph.js';
import { type IndexedToolMeta, upsertIndexedTool } from '../writers/prisma.js';
import { upsertToolVector } from '../writers/qdrant.js';

// Fallback thresholds derived from REGISTRY_CONFIGS.logScale at 1%.
// Single source of truth — logScale lives in registry-config.ts.
// After the first weekly cron run, AppSettings.download_quality_thresholds replaces these.
const REGISTRY_FALLBACK_THRESHOLDS: Record<string, number> = Object.fromEntries(
  Object.entries(REGISTRY_CONFIGS)
    .filter(([, v]) => v.logScale !== undefined)
    .map(([k, v]) => [k, Math.round(v.logScale! / 100)]),
);

// Load download quality thresholds from AppSettings (set by weekly percentile cron).
// Falls back to REGISTRY_FALLBACK_THRESHOLDS until first cron run.
// Cached per-process — refreshed on each worker restart.
let _downloadThresholds: Record<string, number> | null = null;
async function getDownloadThresholds(): Promise<Record<string, number>> {
  if (_downloadThresholds) return _downloadThresholds;
  try {
    const prisma = new PrismaClient();
    const settings = await prisma.appSettings.findUnique({
      where: { id: 'global' },
      select: { download_quality_thresholds: true },
    });
    await prisma.$disconnect();
    if (settings?.download_quality_thresholds) {
      _downloadThresholds = {
        ...REGISTRY_FALLBACK_THRESHOLDS,
        ...(JSON.parse(settings.download_quality_thresholds) as Record<string, number>),
      };
    }
  } catch {
    // Non-fatal
  }
  return _downloadThresholds ?? REGISTRY_FALLBACK_THRESHOLDS;
}

const logger = createLogger({ name: '@toolcairn/indexer:index-consumer' });

function parseToolId(toolId: string): {
  source: 'github' | 'npm' | 'pypi' | 'crates.io';
  url: string;
} {
  if (toolId.startsWith('npm:')) return { source: 'npm', url: toolId.slice(4) };
  if (toolId.startsWith('pypi:')) return { source: 'pypi', url: toolId.slice(5) };
  if (toolId.startsWith('cargo:') || toolId.startsWith('crates.io:')) {
    return { source: 'crates.io', url: toolId.slice(toolId.indexOf(':') + 1) };
  }
  const ownerRepo = toolId
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\/+$/, '');
  return { source: 'github', url: ownerRepo };
}

/**
 * Skip-if-unchanged: compare crawled data against what's stored in Memgraph.
 *
 * Returns the existing tool's id (to update last_indexed_at) if we can safely
 * skip re-processing, or null if a full re-index is needed.
 *
 * GitHub tools: skip when description + pushed_at + stars + forks + is_fork all match.
 * npm/PyPI/crates: skip when description matches (stars/commits not available cheaply).
 *
 * False-negative risk: stale credibility/maintenance data for up to 7 days.
 * Self-corrects on next reindex cycle — not catastrophic.
 */
async function checkIfUnchanged(
  source: string,
  crawlerResult: Awaited<ReturnType<typeof runCrawler>>,
): Promise<
  | { skip: true; existingId: string; prevHealth: { stars: number; updatedAt: string } }
  | { skip: false; prevHealth?: { stars: number; updatedAt: string } }
> {
  try {
    const repo = new MemgraphToolRepository();
    const result = await repo.findByName(crawlerResult.extracted.name);
    if (!result.ok || !result.data) return { skip: false };

    const prev = result.data;
    const prevHealth = { stars: prev.health.stars, updatedAt: prev.updated_at };
    const extracted = crawlerResult.extracted;

    // Description is universal — if it changed, always re-index (affects BM25 + vector)
    if (prev.description !== (extracted.description || '')) {
      return { skip: false, prevHealth };
    }

    if (source === 'github') {
      // For GitHub tools, also check commit date (maintenance score), stars/forks (credibility)
      // and archived status (triggers deprecation detection).
      const raw = crawlerResult.raw as {
        repo?: {
          pushed_at?: string;
          stargazers_count?: number;
          forks_count?: number;
          archived?: boolean;
        };
      };
      const r = raw.repo ?? {};

      // Always re-index archived repos so deprecation detection fires
      if (r.archived) return { skip: false, prevHealth };

      const pushedAtChanged = r.pushed_at && r.pushed_at !== prev.health.last_commit_date;
      // Allow ≤50 star/fork variance to avoid re-indexing on tiny fluctuations
      const starsChanged =
        r.stargazers_count !== undefined && Math.abs(r.stargazers_count - prev.health.stars) > 50;
      const forksChanged =
        r.forks_count !== undefined && Math.abs(r.forks_count - prev.health.forks_count) > 10;
      const forkStatusChanged = (extracted.is_fork ?? false) !== prev.is_fork;

      if (pushedAtChanged || starsChanged || forksChanged || forkStatusChanged) {
        return { skip: false, prevHealth };
      }
    }

    // Nothing meaningful changed
    logger.info(
      { tool: prev.name, source, stars: prev.health.stars },
      'No changes detected — skipping re-index',
    );
    return { skip: true, existingId: prev.id, prevHealth };
  } catch {
    // Non-fatal — if check fails, proceed with full re-index
    return { skip: false };
  }
}

/**
 * Handle a single index job from the queue.
 *
 * Optimisations:
 * 1. Skip-if-unchanged: if the tool's content hasn't changed since last index,
 *    skip processTool + all DB writes (saves Nomic embedding + 3× DB round-trips).
 * 2. Batch Qdrant: uses upsertToolVector (individual) — consumer-level batching
 *    is handled by the worker running multiple concurrent handleIndexJob calls.
 */
export async function handleIndexJob(toolId: string, priority: number): Promise<void> {
  logger.info({ toolId, priority }, 'Handling index job');

  const { source, url } = parseToolId(toolId);
  const canonicalUrl = source === 'github' ? `https://github.com/${url}` : toolId;

  try {
    // 1. Crawl the source
    const crawlerResult = await runCrawler(source, url);
    logger.info({ toolId, source, extractedName: crawlerResult.extracted.name }, 'Crawl complete');

    // 2. Skip-if-unchanged check — read existing state from Memgraph and compare.
    //    If nothing meaningful changed, update last_indexed_at and return early.
    const changeCheck = await checkIfUnchanged(source, crawlerResult);
    if (changeCheck.skip) {
      await upsertIndexedTool(canonicalUrl, changeCheck.existingId, 'indexed');
      return;
    }

    // 3. Process into ToolNode + vector + relationships
    const processedTool = await processTool(crawlerResult, undefined, changeCheck.prevHealth);
    logger.info({ toolId, nodeId: processedTool.node.id }, 'Processing complete');

    const { stars } = processedTool.node.health;
    const channels = processedTool.node.package_managers;

    // Max weekly downloads across all channels (for admin visibility)
    const maxWeeklyDownloads = channels.reduce((max, ch) => Math.max(max, ch.weeklyDownloads), 0);

    // Base meta — stars + downloads stored on every tool for admin visibility
    const baseMeta: IndexedToolMeta = {
      stars,
      weeklyDownloads: maxWeeklyDownloads,
    };

    // 3a. Quality gate: stars OR verified package downloads.
    //     Threshold for downloads comes from AppSettings.download_quality_thresholds
    //     (25th percentile per registry, computed by weekly percentile cron).
    //     Falls back to no download bypass if thresholds not yet computed.
    const thresholds = await getDownloadThresholds();
    const hasGitHubPopularity = stars >= 1000;
    const hasPackageUsage = channels.some((ch) => {
      const threshold = thresholds[ch.registry];
      return threshold !== undefined && ch.weeklyDownloads >= threshold;
    });
    if (!hasGitHubPopularity && !hasPackageUsage && !processedTool.node.grace_until) {
      logger.info(
        { toolId, stars, maxWeeklyDownloads, channels: channels.length },
        'Skipping — insufficient stars and downloads',
      );
      await upsertIndexedTool(canonicalUrl, processedTool.node.id, 'skipped', {
        ...baseMeta,
        skipReason: `stars:${stars} downloads:${maxWeeklyDownloads} thresholds:${JSON.stringify(thresholds)}`,
      });
      return;
    }

    // Note: name collision gate removed. MERGE now keys on github_url (unique per repo),
    // so same-name tools in different ecosystems coexist as separate nodes.
    // Credibility score naturally surfaces the best tool for any given name.

    // 4. Write to all stores concurrently
    const writeResults = await Promise.allSettled([
      writeToolToMemgraph(processedTool.node),
      upsertToolVector(processedTool.node, processedTool.vector),
      upsertIndexedTool(processedTool.node.github_url, processedTool.node.id, 'indexed', baseMeta),
    ]);

    for (const result of writeResults) {
      if (result.status === 'rejected') {
        logger.error({ toolId, error: result.reason }, 'Writer failed (non-fatal)');
      }
    }

    // 5. Write edges — only after the tool node is written
    const memgraphWriteSucceeded = writeResults[0]?.status === 'fulfilled';
    if (memgraphWriteSucceeded) {
      for (const rel of processedTool.relationships) {
        try {
          await writeEdgeToMemgraph(
            processedTool.node.id,
            rel.targetId,
            rel.edgeType,
            rel.weight,
            rel.confidence,
            rel.source,
            rel.decayRate,
          );
        } catch (e) {
          logger.error(
            { toolId, targetId: rel.targetId, edgeType: rel.edgeType, error: e },
            'Edge write failed (non-fatal)',
          );
        }
      }
    } else {
      logger.warn({ toolId }, 'Skipping edge writes — Memgraph tool write failed');
    }

    // 6. Write topic concept nodes
    if (memgraphWriteSucceeded) {
      await writeTopicNodes(processedTool.node.id, processedTool.topicEdges);
    }

    // 7. Incremental REPLACES edges — fire-and-forget.
    //    Requires both Memgraph and Qdrant writes to have succeeded.
    const qdrantWriteSucceeded = writeResults[1]?.status === 'fulfilled';
    if (memgraphWriteSucceeded && qdrantWriteSucceeded) {
      import('../processors/replaces-processor.js')
        .then(({ computeReplacesForTool }) =>
          computeReplacesForTool(processedTool.node.id, processedTool.node.name),
        )
        .catch((e) =>
          logger.warn({ toolId, err: e }, 'Incremental REPLACES computation failed (non-fatal)'),
        );
    }

    // 8. Deprecation check — fire-and-forget
    {
      const { detectDeprecation } = await import('../processors/deprecation-detector.js');
      const { prisma } = await import('@toolcairn/db');
      // biome-ignore lint/suspicious/noExplicitAny: raw is untyped crawler response
      const dep = detectDeprecation(processedTool.node.health, crawlerResult.raw as any);
      if (dep.isDeprecated && dep.reason && dep.severity) {
        prisma.deprecationAlert
          .findFirst({
            where: { tool_name: processedTool.node.name, reason: dep.reason, delivered: false },
          })
          .then(async (existing) => {
            if (!existing) {
              const alert = await prisma.deprecationAlert.create({
                data: {
                  tool_name: processedTool.node.name,
                  reason: dep.reason as string,
                  details: dep.details,
                  severity: dep.severity as string,
                },
              });
              const { deliverDeprecationAlerts } = await import('../workers/alert-worker.js');
              await deliverDeprecationAlerts(
                processedTool.node.name,
                alert.id,
                dep.reason as string,
                dep.severity as string,
                dep.details,
              );
            }
          })
          .catch((e) => logger.error({ toolId, err: e }, 'Deprecation alert non-fatal'));
        logger.warn({ toolId, reason: dep.reason, severity: dep.severity }, 'Deprecation detected');
      }
    }

    logger.info({ toolId, nodeId: processedTool.node.id }, 'Index job complete');
  } catch (e) {
    logger.error({ toolId, err: e }, 'Index job failed');
    try {
      await upsertIndexedTool(canonicalUrl, '', 'failed');
    } catch (prismaErr) {
      logger.error({ toolId, err: prismaErr }, 'Failed to record index failure in staging DB');
    }
  }
}

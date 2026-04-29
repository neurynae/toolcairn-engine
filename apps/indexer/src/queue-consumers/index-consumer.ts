import type { VersionMetadata } from '@toolcairn/core';
import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { enqueueRegistryProbe } from '@toolcairn/queue';
import { runCrawler } from '../crawlers/index.js';
import { REGISTRY_CONFIGS } from '../crawlers/registry-config.js';
import { processTool } from '../processors/index.js';
import {
  writeEdgeToMemgraph,
  writeToolToMemgraph,
  writeTopicNodes,
  writeVersionToMemgraph,
} from '../writers/memgraph.js';
import { type IndexedToolMeta, upsertIndexedTool } from '../writers/prisma.js';
import { upsertToolVector } from '../writers/qdrant.js';

/**
 * Group a flat versionMetadata array by (registry, package_name). The extractor
 * returns history for a single registry/package in one pass; the GitHub path
 * can return multiple groups when a tool is published across several registries.
 * Each group is written as a batch so is_latest flags are set coherently.
 */
function groupVersions(metas: VersionMetadata[]): VersionMetadata[][] {
  const groups = new Map<string, VersionMetadata[]>();
  for (const m of metas) {
    const key = `${m.registry}:${m.packageName}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  return [...groups.values()];
}

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
 * Lookup keys on github_url (not name) — names collide across ecosystems
 * (npm:foo and pypi:foo coexist as distinct nodes), and a name-keyed lookup
 * could match the wrong tool and falsely declare "unchanged".
 *
 * False-negative risk: stale credibility/maintenance data for up to 7 days.
 * Self-corrects on next reindex cycle — not catastrophic.
 */
async function checkIfUnchanged(
  source: string,
  canonicalUrl: string,
  crawlerResult: Awaited<ReturnType<typeof runCrawler>>,
): Promise<
  | { skip: true; existingId: string; prevHealth: { stars: number; updatedAt: string } }
  | { skip: false; prevHealth?: { stars: number; updatedAt: string } }
> {
  try {
    const repo = new MemgraphToolRepository();
    // For GitHub-sourced tools the canonical URL is github_url itself; for
    // npm/PyPI/crates sources canonicalUrl is the registry-prefixed id, which
    // wouldn't match a Tool's github_url. Fall back to findByName for those
    // (registry tools are 1:1 between source and name on those registries).
    const result =
      source === 'github'
        ? await repo.findByGitHubUrl(canonicalUrl)
        : await repo.findByName(crawlerResult.extracted.name);
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
    //    Version metadata is still persisted on skip so the version sub-graph
    //    fills in during the natural 7-day reindex cycle without forcing a
    //    full re-embed. Writes are cheap: MERGE on deterministic Version.id.
    const changeCheck = await checkIfUnchanged(source, canonicalUrl, crawlerResult);
    if (changeCheck.skip) {
      await upsertIndexedTool(canonicalUrl, changeCheck.existingId, 'indexed');
      if (crawlerResult.versionMetadata?.length) {
        for (const group of groupVersions(crawlerResult.versionMetadata)) {
          const first = group[0];
          if (!first) continue;
          try {
            await writeVersionToMemgraph(
              crawlerResult.extracted.name,
              changeCheck.existingId,
              group,
            );
          } catch (e) {
            logger.warn(
              { toolId, versionRegistry: first.registry, err: e },
              'Version write on skip path failed (non-fatal)',
            );
          }
        }
      }
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

    // 3a. Quality gate — high-star OR registry-popular OR grace.
    //
    // Pass conditions (any one):
    //   (a) GitHub popularity: stars >= 1000. High-star repos earn graph space
    //       on community signal alone, including tools distributed as binaries
    //       (powertoys, godot, rustdesk), content/curation (awesome-lists,
    //       education repos), or via unverifiable registries.
    //   (b) at least one package channel whose weekly downloads clear its
    //       registry's 25th-percentile threshold
    //       (AppSettings.download_quality_thresholds, updated by the weekly
    //        percentile cron; falls back to REGISTRY_FALLBACK_THRESHOLDS
    //        derived from REGISTRY_CONFIGS.logScale). Catches sub-1000★ but
    //        registry-popular tools like smol-toml (271★, 11M+ npm weekly).
    //   (c) an explicit grace_until window set by an admin or submission flow.
    //
    // Channel discovery still runs for every repo regardless of stars — the
    // discovered registry data is persisted on the IndexedTool row whether
    // the repo passes the gate or not.
    const thresholds = await getDownloadThresholds();
    const hasGitHubPopularity = stars >= 1000;
    const hasPackageUsage = channels.some((ch) => {
      const threshold = thresholds[ch.registry];
      return threshold !== undefined && ch.weeklyDownloads >= threshold;
    });
    if (!hasGitHubPopularity && !hasPackageUsage && !processedTool.node.grace_until) {
      logger.info(
        { toolId, stars, maxWeeklyDownloads, channels: channels.length },
        'Skipping — under 1000★ and no verified package channel with qualifying downloads',
      );
      await upsertIndexedTool(canonicalUrl, processedTool.node.id, 'skipped', {
        ...baseMeta,
        skipReason: `stars:${stars} channels:${channels.length} max_weekly_dl:${maxWeeklyDownloads} thresholds:${JSON.stringify(thresholds)}`,
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

    // 6b. Write version nodes + version edges (non-fatal — graceful degradation).
    //     versionMetadata is populated by crawler dispatcher per registry; each
    //     group (registry, package_name) is written as a coherent batch so the
    //     is_latest flag settles on exactly one version per group.
    if (memgraphWriteSucceeded && crawlerResult.versionMetadata?.length) {
      for (const group of groupVersions(crawlerResult.versionMetadata)) {
        const first = group[0];
        if (!first) continue;
        try {
          await writeVersionToMemgraph(processedTool.node.name, processedTool.node.id, group);
        } catch (e) {
          logger.warn(
            { toolId, versionRegistry: first.registry, err: e },
            'Version write failed (non-fatal)',
          );
        }
      }
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

    // 9. Enqueue side-queue registry probe — fast handoff so the slow
    //    pypistats/etc. download fetch happens off the main GitHub-bound
    //    flow. The probe handler will update package_managers + IndexedTool
    //    weekly_downloads at the adaptive rate limiter's pace. Only fire when
    //    the tool was actually indexed (skipped tools don't need enrichment).
    //
    //    For high-star repos the crawler ran with skipDownloads=true, so this
    //    enqueue is the ONLY way their download counts get filled in. For
    //    sub-1k repos the crawler already filled them in inline; the probe is
    //    a refresh (and a no-op if rate limiter says we have current data).
    if (memgraphWriteSucceeded) {
      enqueueRegistryProbe(processedTool.node.github_url).catch((err) =>
        logger.warn({ toolId, err }, 'enqueueRegistryProbe failed (non-fatal)'),
      );
    }

    logger.info({ toolId, nodeId: processedTool.node.id }, 'Index job complete');
  } catch (e) {
    // Crawler-signalled "too large to index" — record as skipped with a clear
    // reason so the pending-watchdog doesn't keep re-enqueueing it. Must match
    // the error's `skipReason` field from the MegaRepoSkip class.
    const isMegaSkip =
      e instanceof Error &&
      e.name === 'MegaRepoSkip' &&
      'skipReason' in e &&
      typeof (e as { skipReason: unknown }).skipReason === 'string';
    if (isMegaSkip) {
      const skipReason = (e as { skipReason: string }).skipReason;
      logger.warn({ toolId, skipReason }, 'Skipping oversized repo');
      try {
        await upsertIndexedTool(canonicalUrl, '', 'skipped', { skipReason });
      } catch (prismaErr) {
        logger.error({ toolId, err: prismaErr }, 'Failed to record skip in staging DB');
      }
      return;
    }

    logger.error({ toolId, err: e }, 'Index job failed');
    try {
      await upsertIndexedTool(canonicalUrl, '', 'failed');
    } catch (prismaErr) {
      logger.error({ toolId, err: prismaErr }, 'Failed to record index failure in staging DB');
    }
  }
}

import pino from 'pino';
import { runCrawler } from '../crawlers/index.js';
import { processTool } from '../processors/index.js';
import { writeEdgeToMemgraph, writeToolToMemgraph, writeTopicNodes } from '../writers/memgraph.js';
import { upsertIndexedTool } from '../writers/prisma.js';
import { upsertToolVector } from '../writers/qdrant.js';

const logger = pino({ name: '@toolcairn/indexer:index-consumer' });

/**
 * Determine crawler source and URL from a toolId.
 * Currently treats toolId as "owner/repo" (GitHub format).
 * Future: support "npm:package-name", "pypi:package-name", "cargo:crate-name" prefixes.
 */
function parseToolId(toolId: string): {
  source: 'github' | 'npm' | 'pypi' | 'crates.io';
  url: string;
} {
  if (toolId.startsWith('npm:')) {
    return { source: 'npm', url: toolId.slice(4) };
  }
  if (toolId.startsWith('pypi:')) {
    return { source: 'pypi', url: toolId.slice(5) };
  }
  if (toolId.startsWith('cargo:') || toolId.startsWith('crates.io:')) {
    const colonIdx = toolId.indexOf(':');
    return { source: 'crates.io', url: toolId.slice(colonIdx + 1) };
  }
  // GitHub: normalize to canonical "owner/repo" path for the crawler.
  // Any format (full URL, http, short owner/repo, trailing slash) → owner/repo.
  const ownerRepo = toolId
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\/+$/, '');
  return { source: 'github', url: ownerRepo };
}

/**
 * Handle a single index job from the queue.
 * Flow: parse toolId → runCrawler → processTool → write to all stores.
 * Individual write failures are logged but do not abort the pipeline.
 */
export async function handleIndexJob(toolId: string, priority: number): Promise<void> {
  logger.info({ toolId, priority }, 'Handling index job');

  // Compute canonical URL once so the failure path can use it too
  const { source, url } = parseToolId(toolId);
  const canonicalUrl = source === 'github' ? `https://github.com/${url}` : toolId;

  try {
    // 1. Crawl the source
    const crawlerResult = await runCrawler(source, url);
    logger.info({ toolId, source, extractedName: crawlerResult.extracted.name }, 'Crawl complete');

    // 1b. Fetch previous health snapshot for accurate stars_velocity_90d calculation.
    // Non-fatal — falls back to first-index estimate if not found.
    let prevHealth: { stars: number; updatedAt: string } | undefined;
    try {
      const { MemgraphToolRepository } = await import('@toolcairn/graph');
      const repo = new MemgraphToolRepository();
      const existing = await repo.findByName(crawlerResult.extracted.name);
      if (existing.ok && existing.data) {
        prevHealth = { stars: existing.data.health.stars, updatedAt: existing.data.updated_at };
      }
    } catch {
      // Non-fatal — real velocity will be computed on next re-index cycle
    }

    // 2. Process into ToolNode + vector + relationships
    const processedTool = await processTool(crawlerResult, undefined, prevHealth);
    logger.info({ toolId, nodeId: processedTool.node.id }, 'Processing complete');

    // 3. Write to all stores concurrently
    const writeResults = await Promise.allSettled([
      writeToolToMemgraph(processedTool.node),
      upsertToolVector(processedTool.node, processedTool.vector),
      upsertIndexedTool(processedTool.node.github_url, processedTool.node.id, 'indexed'),
    ]);

    for (const result of writeResults) {
      if (result.status === 'rejected') {
        logger.error({ toolId, error: result.reason }, 'Writer failed (non-fatal)');
      }
    }

    // 4. Write edges — only after the tool node is written
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

    // 5. Write topic concept nodes (UseCase/Pattern/Stack) and their edges
    if (memgraphWriteSucceeded) {
      await writeTopicNodes(processedTool.node.id, processedTool.topicEdges);
    }

    // 6. Deprecation check — fire-and-forget, non-fatal
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
              // Deliver webhooks to subscribers
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
    // Attempt to record the failure in the staging DB
    try {
      await upsertIndexedTool(canonicalUrl, '', 'failed');
    } catch (prismaErr) {
      logger.error({ toolId, err: prismaErr }, 'Failed to record index failure in staging DB');
    }
  }
}

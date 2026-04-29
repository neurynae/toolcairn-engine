import type { PackageChannel } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { fetchPackageDownloads } from '../crawlers/download-fetcher.js';
import { upsertIndexedTool } from '../writers/prisma.js';

const logger = createLogger({ name: '@toolcairn/indexer:registry-probe' });

/**
 * Side-queue handler — refreshes weekly_downloads for an already-indexed tool.
 *
 * Triggered after a successful index-job by `enqueueRegistryProbe`. The main
 * indexer flow runs with `skipDownloads: true` for high-star repos, so this
 * handler is the path that actually populates the download counts. For sub-1k
 * repos the inline path already populated downloads; this handler then acts
 * as a refresh.
 *
 * The slow per-host rate limiter inside `fetchPackageDownloads` (download-fetcher.ts)
 * paces requests to pypistats etc. without blocking the main GitHub-bound
 * consumer. Probe failures are non-fatal — the next scheduled reindex will
 * retry, and stale downloads don't break the gate (gate has already passed).
 */
export async function handleRegistryProbe(toolId: string): Promise<void> {
  // toolId is the canonical github_url written by upsertIndexedTool. Older
  // enqueues used the lower-case form; the repository's findByGitHubUrl uses
  // a CONTAINS match which tolerates case + trailing slash differences.
  const repo = new MemgraphToolRepository();
  const result = await repo.findByGitHubUrl(toolId);
  if (!result.ok || !result.data) {
    logger.debug({ toolId }, 'Probe target not in graph — skipping');
    return;
  }

  const tool = result.data;
  const channels = tool.package_managers ?? [];
  if (channels.length === 0) {
    logger.debug({ toolId, name: tool.name }, 'Probe: no channels to refresh');
    return;
  }

  // Refresh downloads in parallel — the per-host adaptive limiter inside
  // fetchPackageDownloads naturally serialises requests to slow hosts
  // (pypistats) while letting fast hosts proceed unhindered.
  const refreshed: PackageChannel[] = await Promise.all(
    channels.map(async (ch) => {
      try {
        const weekly = await fetchPackageDownloads(ch.registry, ch.packageName);
        return { ...ch, weeklyDownloads: weekly };
      } catch (e) {
        logger.warn(
          { toolId, registry: ch.registry, pkg: ch.packageName, err: e },
          'Probe: download fetch failed (keeping prior value)',
        );
        return ch;
      }
    }),
  );

  const maxWeekly = refreshed.reduce((m, ch) => Math.max(m, ch.weeklyDownloads), 0);

  // Write the refreshed channels back to Memgraph + Postgres. createTool is
  // an upsert that overwrites package_managers as a JSON-serialised string.
  try {
    const updated = { ...tool, package_managers: refreshed };
    await repo.createTool(updated);
  } catch (e) {
    logger.warn({ toolId, err: e }, 'Probe: Memgraph upsert failed');
  }

  try {
    await upsertIndexedTool(tool.github_url, tool.id, 'indexed', {
      stars: tool.health.stars,
      weeklyDownloads: maxWeekly,
    });
  } catch (e) {
    logger.warn({ toolId, err: e }, 'Probe: IndexedTool update failed');
  }

  logger.info(
    {
      toolId,
      name: tool.name,
      channels: refreshed.length,
      maxWeekly,
    },
    'Registry probe complete',
  );
}

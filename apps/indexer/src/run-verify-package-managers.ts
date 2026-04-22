/**
 * One-time backfill: re-verify every indexed Tool's `package_managers` entries
 * against their respective registry APIs. Drop entries that fail verification.
 *
 * Why
 * ---
 * The pre-v0.10.x GitHub crawler built `package_managers` from raw README scrapes
 * without consuming the (already-implemented) registry-side ownership check in
 * download-fetcher.ts. Result: tools like `llm-scraper` ended up claiming
 * `(npm, zod)` (because an `npm install zod` line appeared in their README),
 * and `pmndrs/react-three-fiber` claimed `(npm, three)` (peer dep documented
 * ahead of its own package). These bogus entries poisoned the MCP resolver's
 * `registry_package_keys` lookup, which then returned the wrong Tool for a
 * given manifest declaration.
 *
 * The fix landed alongside this script: github.ts now consumes
 * `verifyAndFetchAllChannels` so NEW tool crawls write only verified entries.
 * This script retrofits existing tools.
 *
 * Conservative
 * ------------
 * - REMOVE only. Entries the registry's own API disowns (repoUrlField does not
 *   point back to our tool's github_url) are dropped. Nothing is ever added
 *   by this script — missing channels stay missing (a separate re-crawl can
 *   address those).
 * - Registries without a metadataUrl (hackage, cpan, luarocks, nimble, opam,
 *   vcpkg, conan, spm, elm, nix, plus some misc) return `unverifiable` —
 *   those pass through untouched.
 * - Writes happen only when something actually changed for a tool.
 * - DRY_RUN mode prints every proposed removal without touching either store.
 *
 * Usage:
 *   pnpm tsx src/run-verify-package-managers.ts
 *
 * Environment:
 *   DRY_RUN=1       - preview removals, no writes
 *   START_AFTER=id  - resume after a specific Qdrant point id
 *   BATCH_SIZE=200  - points per scroll page (default 200)
 *   TOOL_PARALLEL=8 - per-batch concurrency cap (default 8)
 *   SLEEP_MS=250    - pause between batches to be gentle with registry APIs
 */

import type { PackageChannel } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { type OwnershipVerdict, verifyChannelOwnership } from './crawlers/download-fetcher.js';

const logger = createLogger({ name: '@toolcairn/indexer:verify-pms' });

const DRY_RUN = process.env.DRY_RUN === '1';
const START_AFTER = process.env.START_AFTER ?? null;
const BATCH_SIZE = (() => {
  const v = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);
  return v > 0 ? v : 200;
})();
const TOOL_PARALLEL = (() => {
  const v = Number.parseInt(process.env.TOOL_PARALLEL ?? '', 10);
  return v > 0 ? v : 8;
})();
const SLEEP_MS = (() => {
  const v = Number.parseInt(process.env.SLEEP_MS ?? '', 10);
  return v >= 0 ? v : 250;
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull `<owner>/<repo>` out of a GitHub URL — null for non-github hosts. */
function parseOwnerRepo(githubUrl: string | undefined): { owner: string; repo: string } | null {
  if (!githubUrl) return null;
  const match = githubUrl.match(/github\.com\/([^/]+)\/([^/?#.]+)/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

/** Derived indexable form of package_managers — matches the indexer writer. */
function deriveRegistryPackageKeys(pms: PackageChannel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pc of pms) {
    if (!pc?.registry || !pc?.packageName) continue;
    const key = `${pc.registry}:${pc.packageName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Iterator-driven pool — caps concurrency across the batch. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const pool = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(pool);
  return out;
}

interface BackfillStats {
  scanned: number;
  skipped_no_github: number;
  skipped_no_channels: number;
  tools_with_removals: number;
  entries_removed: number;
  tools_emptied: number;
  verification_errors: number;
  memgraph_writes: number;
  qdrant_writes: number;
}

interface PointLike {
  id: string | number;
  payload: Record<string, unknown>;
}

interface VerificationResult {
  removed: PackageChannel[];
  kept: PackageChannel[];
  verdicts: Record<string, OwnershipVerdict>;
  errored: boolean;
}

async function verifyAllEntries(
  pms: PackageChannel[],
  owner: string,
  repo: string,
): Promise<VerificationResult> {
  const verdicts: Record<string, OwnershipVerdict> = {};
  const kept: PackageChannel[] = [];
  const removed: PackageChannel[] = [];
  let errored = false;

  // Per-tool sequential verification — small N per tool (usually 1-3), and
  // concurrent across tools already saturates the registry APIs.
  for (const ch of pms) {
    if (!ch?.registry || !ch?.packageName) {
      // Malformed entry — drop it silently.
      removed.push(ch);
      continue;
    }
    try {
      const verdict = await verifyChannelOwnership(ch.registry, ch.packageName, owner, repo);
      verdicts[`${ch.registry}:${ch.packageName}`] = verdict;
      if (verdict === 'rejected') {
        removed.push(ch);
      } else {
        kept.push(ch);
      }
    } catch (err) {
      errored = true;
      // On error, err on the side of keeping — we don't want a transient
      // network blip to wipe accurate data.
      kept.push(ch);
      logger.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          registry: ch.registry,
          pkg: ch.packageName,
        },
        'Verification errored — keeping entry as-is',
      );
    }
  }

  return { removed, kept, verdicts, errored };
}

async function writeMemgraph(pointId: string | number, pms: PackageChannel[]): Promise<void> {
  const session = getMemgraphSession();
  try {
    await session.run('MATCH (t:Tool { id: $id }) SET t.package_managers = $pms', {
      id: String(pointId),
      pms: JSON.stringify(pms),
    });
  } finally {
    await session.close();
  }
}

async function writeQdrant(pointId: string | number, pms: PackageChannel[]): Promise<void> {
  const keys = deriveRegistryPackageKeys(pms);
  await qdrantClient().setPayload(COLLECTION_NAME, {
    points: [pointId],
    payload: {
      package_managers: pms,
      registry_package_keys: keys,
    },
    wait: false,
  });
}

async function main(): Promise<void> {
  logger.info(
    { DRY_RUN, START_AFTER, BATCH_SIZE, TOOL_PARALLEL, SLEEP_MS, COLLECTION_NAME },
    'Starting package_managers re-verification backfill',
  );

  const stats: BackfillStats = {
    scanned: 0,
    skipped_no_github: 0,
    skipped_no_channels: 0,
    tools_with_removals: 0,
    entries_removed: 0,
    tools_emptied: 0,
    verification_errors: 0,
    memgraph_writes: 0,
    qdrant_writes: 0,
  };

  const client = qdrantClient();
  let offset: string | number | null | undefined = START_AFTER ?? undefined;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const res = await client.scroll(COLLECTION_NAME, {
      limit: BATCH_SIZE,
      offset,
      with_payload: ['name', 'github_url', 'package_managers'],
      with_vector: false,
    });

    const points = (res.points ?? []) as PointLike[];
    if (points.length === 0) break;
    stats.scanned += points.length;

    // Filter to just the points we can meaningfully touch.
    const workable: Array<{
      point: PointLike;
      owner: string;
      repo: string;
      pms: PackageChannel[];
    }> = [];
    for (const p of points) {
      const pms = (p.payload.package_managers as PackageChannel[] | undefined) ?? [];
      if (!Array.isArray(pms) || pms.length === 0) {
        stats.skipped_no_channels++;
        continue;
      }
      const or = parseOwnerRepo(p.payload.github_url as string | undefined);
      if (!or) {
        stats.skipped_no_github++;
        continue;
      }
      workable.push({ point: p, owner: or.owner, repo: or.repo, pms });
    }

    const batchResults = await runWithConcurrency(workable, TOOL_PARALLEL, async (w) => {
      const { removed, kept, verdicts, errored } = await verifyAllEntries(w.pms, w.owner, w.repo);
      if (errored) stats.verification_errors++;
      if (removed.length === 0) return { changed: false };

      stats.tools_with_removals++;
      stats.entries_removed += removed.length;
      if (kept.length === 0) stats.tools_emptied++;

      const name = (w.point.payload.name as string | undefined) ?? String(w.point.id);
      logger.info(
        {
          id: w.point.id,
          name,
          repo: `${w.owner}/${w.repo}`,
          removed: removed.map((r) => `${r.registry}:${r.packageName}`),
          kept: kept.map((r) => `${r.registry}:${r.packageName}`),
          verdicts,
        },
        DRY_RUN ? 'Would remove' : 'Removing',
      );

      if (!DRY_RUN) {
        try {
          await writeMemgraph(w.point.id, kept);
          stats.memgraph_writes++;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), id: w.point.id },
            'Memgraph write failed',
          );
        }
        try {
          await writeQdrant(w.point.id, kept);
          stats.qdrant_writes++;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), id: w.point.id },
            'Qdrant setPayload failed',
          );
        }
      }
      return { changed: true };
    });

    logger.info(
      {
        batch: batchNum,
        scanned_total: stats.scanned,
        workable_in_batch: workable.length,
        changed_in_batch: batchResults.filter((b) => b.changed).length,
        last_id: points[points.length - 1]?.id,
      },
      'Batch done',
    );

    offset = res.next_page_offset as string | number | null | undefined;
    if (offset === null || offset === undefined) break;
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  logger.info({ ...stats, DRY_RUN }, 'Backfill complete');

  await closeMemgraphDriver();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Backfill crashed');
    process.exit(1);
  });

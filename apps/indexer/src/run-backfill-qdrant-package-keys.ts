/**
 * One-time backfill: populate `registry_package_keys` on every existing
 * Qdrant point in the 'tools' collection.
 *
 * Why: v0.10 MCP's toolcairn_init resolver (POST /v1/tools/batch-resolve) uses
 * Qdrant's payload filter on `registry_package_keys` to map manifest declarations
 * like `{"next": "^14"}` back to the canonical Tool (Vercel's Next.js) via its
 * npm channel. New indexer runs populate the field automatically; this script
 * retrofits existing points.
 *
 * Safety: Qdrant `setPayload` is a MERGE, not a replace. Existing fields
 * (name, github_url, package_managers, keyword_sentence, vectors, …) are all
 * preserved. Only `registry_package_keys` is added/overwritten.
 *
 * Usage:
 *   pnpm tsx src/run-backfill-qdrant-package-keys.ts
 *
 * Environment variables:
 *   DRY_RUN=1       — scroll + derive + log, do not write
 *   START_AFTER=id  — resume after a specific Qdrant point id
 *   BATCH_SIZE=500  — points per scroll page (default 500)
 *   SLEEP_MS=100    — pause between batches (default 100ms)
 */

import type { PackageChannel } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:backfill-package-keys' });

const DRY_RUN = process.env.DRY_RUN === '1';
const START_AFTER = process.env.START_AFTER ?? null;
const BATCH_SIZE = (() => {
  const v = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);
  return v > 0 ? v : 500;
})();
const SLEEP_MS = (() => {
  const v = Number.parseInt(process.env.SLEEP_MS ?? '', 10);
  return v >= 0 ? v : 100;
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveKeys(pms: PackageChannel[] | undefined): string[] {
  if (!Array.isArray(pms)) return [];
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

interface BackfillStats {
  scanned: number;
  written: number;
  skipped_empty: number;
  skipped_already_correct: number;
  failed: number;
}

async function main(): Promise<void> {
  const client = qdrantClient();
  logger.info(
    { DRY_RUN, START_AFTER, BATCH_SIZE, SLEEP_MS, COLLECTION_NAME },
    'Starting registry_package_keys backfill',
  );

  const stats: BackfillStats = {
    scanned: 0,
    written: 0,
    skipped_empty: 0,
    skipped_already_correct: 0,
    failed: 0,
  };

  let offset: string | number | null | undefined = START_AFTER ?? undefined;
  let batch = 0;

  while (true) {
    batch++;
    const res = await client.scroll(COLLECTION_NAME, {
      limit: BATCH_SIZE,
      offset,
      with_payload: ['package_managers', 'registry_package_keys', 'name'],
      with_vector: false,
    });

    const points = res.points ?? [];
    if (points.length === 0) break;

    stats.scanned += points.length;

    // Build per-point payload updates
    const updates: Array<{ id: string | number; keys: string[]; name?: string }> = [];
    for (const point of points) {
      const payload = point.payload ?? {};
      const pms = payload.package_managers as PackageChannel[] | undefined;
      const existing = payload.registry_package_keys as string[] | undefined;
      const keys = deriveKeys(pms);

      if (keys.length === 0) {
        stats.skipped_empty++;
        continue;
      }

      // Skip if already present and matching — cheap optimisation for resumed runs.
      if (
        Array.isArray(existing) &&
        existing.length === keys.length &&
        existing.every((k, i) => k === keys[i])
      ) {
        stats.skipped_already_correct++;
        continue;
      }

      updates.push({
        id: point.id as string | number,
        keys,
        name: payload.name as string | undefined,
      });
    }

    if (DRY_RUN) {
      logger.info(
        {
          batch,
          scanned_total: stats.scanned,
          would_write: updates.length,
          sample: updates.slice(0, 3),
        },
        'DRY_RUN: would apply setPayload for this batch',
      );
    } else {
      // One setPayload call per point — Qdrant supports selecting points via filter
      // but per-point payloads require per-point calls. This is still fast at 500/batch.
      await Promise.all(
        updates.map(async (u) => {
          try {
            await client.setPayload(COLLECTION_NAME, {
              points: [u.id],
              payload: { registry_package_keys: u.keys },
              wait: false,
            });
            stats.written++;
          } catch (e) {
            stats.failed++;
            logger.warn(
              {
                id: u.id,
                name: u.name,
                err: e instanceof Error ? e.message : String(e),
              },
              'setPayload failed',
            );
          }
        }),
      );

      logger.info(
        {
          batch,
          scanned_total: stats.scanned,
          written_in_batch: updates.length,
          last_id: points[points.length - 1]?.id,
        },
        'Batch done',
      );
    }

    offset = res.next_page_offset as string | number | null | undefined;
    if (offset === null || offset === undefined) break;
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  logger.info({ ...stats, DRY_RUN }, 'Backfill complete');

  // Verification pass: count points with package_managers but no registry_package_keys.
  if (!DRY_RUN) {
    let holes = 0;
    let checked = 0;
    let cursor: string | number | null | undefined = undefined;
    while (true) {
      const res = await client.scroll(COLLECTION_NAME, {
        limit: 500,
        offset: cursor,
        with_payload: ['package_managers', 'registry_package_keys'],
        with_vector: false,
      });
      const pts = res.points ?? [];
      if (pts.length === 0) break;
      for (const p of pts) {
        checked++;
        const pms = p.payload?.package_managers as PackageChannel[] | undefined;
        const keys = p.payload?.registry_package_keys as string[] | undefined;
        if (Array.isArray(pms) && pms.length > 0 && (!Array.isArray(keys) || keys.length === 0)) {
          holes++;
          if (holes <= 10) {
            logger.warn(
              { id: p.id, name: p.payload?.name },
              'Hole: has package_managers but no registry_package_keys',
            );
          }
        }
      }
      cursor = res.next_page_offset as string | number | null | undefined;
      if (cursor === null || cursor === undefined) break;
    }
    logger.info({ checked, holes }, 'Verification pass complete');
    if (holes > 0) {
      logger.error({ holes }, 'Backfill left gaps — re-run required');
      process.exitCode = 1;
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Backfill crashed');
    process.exit(1);
  });

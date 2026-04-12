/**
 * Cleanup: enforce quality standards for personal GitHub repos (owner.type = 'User').
 *
 * Rules:
 *  - Personal repos with >= 1000 stars: keep (they've proven themselves)
 *  - Personal repos with 500-999 stars: grace period (up to 4 × 1-week retries = ~1 month)
 *      - First detection: start 7-day window (grace_until = now+7d, grace_retries = 1)
 *      - Window active: skip (check again later)
 *      - Window expired + stars still < 1000 + retries < 4: extend another week
 *      - Window expired + retries >= 4 + still < 1000: DELETE
 *  - Personal repos with < 500 stars: DELETE immediately (too low quality to hold)
 *  - Org repos: always keep, never touched here
 *
 * Usage:
 *   pnpm tsx src/cleanup-personal-repos.ts          # dry run (safe, default)
 *   pnpm tsx src/cleanup-personal-repos.ts --delete # actually delete
 *
 * Uses the dual-token pool — run with GITHUB_TOKEN + GITHUB_TOKEN_2 in .env.
 * Designed to be run weekly (e.g. cron) so grace window checks stay accurate.
 */

import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { getBestCoreSlot, getSlots } from './crawlers/rate-limit.js';

const logger = createLogger({ name: '@toolcairn/indexer:cleanup-personal-repos' });
const DRY_RUN = !process.argv.includes('--delete');

const STAR_THRESHOLD = 1000;
const GRACE_FLOOR = 500; // below this: delete immediately, no grace
const GRACE_DAYS = 7;
const MAX_RETRIES = 4;

function parseOwner(githubUrl: string): string | null {
  try {
    const url = new URL(githubUrl);
    if (!url.hostname.includes('github.com')) return null;
    return url.pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Retry a Memgraph write on transaction-conflict errors (serialization failures). */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 6, baseDelayMs = 3000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isConflict =
        e instanceof Error &&
        (e.message.includes('Cannot resolve conflicting transactions') ||
          e.message.includes('conflicting transaction'));
      if (!isConflict || attempt === maxAttempts) throw e;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 1000;
      logger.warn(
        { attempt, maxAttempts, delayMs: Math.round(delay) },
        'Memgraph transaction conflict — retrying after delay',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

/** Run a single write query in its own fresh session with retry on conflict. */
async function writeWithRetry(query: string, params: Record<string, unknown>): Promise<void> {
  await withRetry(async () => {
    const ws = getMemgraphSession();
    try {
      await ws.run(query, params);
    } finally {
      await ws.close();
    }
  });
}

async function main() {
  if (DRY_RUN) logger.info('DRY RUN — pass --delete to commit changes');

  const session = getMemgraphSession();

  try {
    // ── 1. Fetch all GitHub tools with < STAR_THRESHOLD stars ──────────────────
    const result = await session.run(
      `MATCH (t:Tool)
       WHERE t.github_url CONTAINS 'github.com'
         AND t.health_stars < $threshold
       RETURN t.name AS name,
              t.github_url AS github_url,
              t.health_stars AS stars,
              t.owner_type AS owner_type,
              t.grace_until AS grace_until,
              t.grace_retries AS grace_retries`,
      { threshold: STAR_THRESHOLD },
    );

    const tools = result.records.map((r) => {
      const rawStars = r.get('stars') as unknown;
      return {
        name: r.get('name') as string,
        github_url: r.get('github_url') as string,
        stars:
          typeof rawStars === 'object' && rawStars !== null && 'toNumber' in rawStars
            ? (rawStars as { toNumber: () => number }).toNumber()
            : (rawStars as number),
        owner_type: r.get('owner_type') as string | null,
        grace_until: r.get('grace_until') as string | null,
        grace_retries: (() => {
          const v = r.get('grace_retries') as unknown;
          if (typeof v === 'object' && v !== null && 'toNumber' in v)
            return (v as { toNumber(): number }).toNumber();
          return typeof v === 'number' ? v : 0;
        })(),
      };
    });

    logger.info({ total: tools.length }, `Tools with < ${STAR_THRESHOLD} stars`);

    // ── 2. Identify owners needing API check (no owner_type stored yet) ────────
    const needsCheck = tools.filter((t) => !t.owner_type);
    const ownerSet = new Set(
      needsCheck.map((t) => parseOwner(t.github_url)).filter(Boolean) as string[],
    );

    if (ownerSet.size > 0) {
      const allSlots = getSlots();
      const combinedRemaining = allSlots.reduce((sum: number, s) => sum + s.core.remaining, 0);
      logger.info(
        {
          combinedRemaining,
          ownersToCheck: ownerSet.size,
          slots: allSlots.map((s) => `${s.label}:${s.core.remaining}`).join(', '),
        },
        'Rate limit across token pool',
      );
      if (combinedRemaining < 500) {
        logger.error({ combinedRemaining }, 'Rate limit critically low — aborting');
        return;
      }
      if (combinedRemaining < ownerSet.size) {
        logger.warn(
          { combinedRemaining, needed: ownerSet.size },
          'Combined quota < owners to check — will auto-pause at reset boundaries',
        );
      }
    }

    // ── 3. Resolve owner types via GitHub API ──────────────────────────────────
    const personalOwners = new Set<string>();
    const orgOwners = new Set<string>();

    // Pre-populate from already-stored data
    for (const t of tools) {
      const owner = parseOwner(t.github_url);
      if (!owner) continue;
      if (t.owner_type === 'User') personalOwners.add(owner);
      if (t.owner_type === 'Organization') orgOwners.add(owner);
    }

    // API check only for unknowns
    const unknownOwners = [...ownerSet].filter((o) => !personalOwners.has(o) && !orgOwners.has(o));
    logger.info(
      { knownPersonal: personalOwners.size, unknownOwners: unknownOwners.length },
      'Owner type resolution',
    );

    let checked = 0;
    for (const owner of unknownOwners) {
      const best = getBestCoreSlot();
      try {
        const resp = await best.octokit.users.getByUsername({ username: owner });
        if (resp.data.type === 'User') personalOwners.add(owner);
        else orgOwners.add(owner);

        if (checked % 50 === 0) {
          // Check the BEST available slot's remaining — not just the last-used slot.
          // getBestCoreSlot() already auto-switches to secondary when primary is low,
          // so only pause when even the best slot is critically low.
          const bestNow = getBestCoreSlot();
          const bestRem = bestNow.core.remaining;
          if (bestRem < 200 && bestNow.core.resetAt > 0) {
            const waitMs = Math.max(0, bestNow.core.resetAt * 1000 - Date.now()) + 5000;
            logger.warn(
              { bestRem, token: bestNow.label, waitSecs: Math.round(waitMs / 1000) },
              'All tokens low — pausing until soonest reset',
            );
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      } catch (e) {
        logger.warn({ owner, err: e }, 'Owner lookup failed — skipping');
      }
      checked++;
      if (checked % 100 === 0)
        logger.info({ checked, total: unknownOwners.length }, 'Owner lookup progress');
    }

    logger.info({ personalOwners: personalOwners.size }, 'Personal owners identified');

    // ── 4. Apply grace period rules ────────────────────────────────────────────
    const toDeleteNow: string[] = []; // immediate delete
    const toStartGrace: string[] = []; // first time in 500-999 range
    const toExtendGrace: Array<{ name: string; retries: number }> = []; // window expired, extend
    const toDeleteGrace: string[] = []; // exhausted retries
    const stillInGrace: number[] = []; // window still active

    const now = new Date();

    for (const tool of tools) {
      const owner = parseOwner(tool.github_url);
      if (!owner || !personalOwners.has(owner)) continue; // org or unknown → skip

      if (tool.stars >= GRACE_FLOOR && tool.stars < STAR_THRESHOLD) {
        // Grace period candidate
        if (!tool.grace_until) {
          // First detection — start grace
          toStartGrace.push(tool.name);
        } else {
          const expiresAt = new Date(tool.grace_until);
          if (expiresAt > now) {
            // Still in grace window
            stillInGrace.push(tool.stars);
          } else {
            // Window expired
            if (tool.grace_retries >= MAX_RETRIES) {
              toDeleteGrace.push(tool.name);
            } else {
              toExtendGrace.push({ name: tool.name, retries: tool.grace_retries });
            }
          }
        }
      } else if (tool.stars < GRACE_FLOOR) {
        // Below floor — delete immediately
        toDeleteNow.push(tool.name);
      }
      // stars >= STAR_THRESHOLD would not appear in this query
    }

    logger.info(
      {
        immediateDelete: toDeleteNow.length,
        startingGrace: toStartGrace.length,
        extendingGrace: toExtendGrace.length,
        graceExhaustedDelete: toDeleteGrace.length,
        stillInGrace: stillInGrace.length,
      },
      'Grace period summary',
    );

    if (DRY_RUN) {
      if (toDeleteNow.length)
        logger.info({ sample: toDeleteNow.slice(0, 10) }, 'Would delete immediately (< 500 stars)');
      if (toStartGrace.length)
        logger.info(
          { sample: toStartGrace.slice(0, 10) },
          'Would start 7-day grace (500-999 stars, first time)',
        );
      if (toExtendGrace.length)
        logger.info(
          {
            sample: toExtendGrace
              .slice(0, 10)
              .map((t) => `${t.name}(retry ${t.retries + 1}/${MAX_RETRIES})`),
          },
          'Would extend grace',
        );
      if (toDeleteGrace.length)
        logger.info(
          { sample: toDeleteGrace.slice(0, 10) },
          'Would delete (grace exhausted after 4 retries)',
        );
      logger.info('Re-run with --delete to commit');
      return;
    }

    // ── 5. Commit changes ──────────────────────────────────────────────────────
    // Close the long-running read session BEFORE starting writes so it doesn't
    // hold any implicit read transaction that could block the write sessions.
    await session.close();

    const allToDelete = [...toDeleteNow, ...toDeleteGrace];

    // Smaller batches (50) reduce per-transaction lock scope and shorten the
    // conflict window against the concurrent permanent indexer.
    const BATCH = 50;

    if (allToDelete.length > 0) {
      let deleted = 0;
      for (let i = 0; i < allToDelete.length; i += BATCH) {
        const batch = allToDelete.slice(i, i + BATCH);
        await writeWithRetry('MATCH (t:Tool) WHERE t.name IN $names DETACH DELETE t', {
          names: batch,
        });
        deleted += batch.length;
      }
      logger.info({ deleted }, 'Tools deleted');
    }

    if (toStartGrace.length > 0) {
      const graceUntil = addDays(GRACE_DAYS);
      for (let i = 0; i < toStartGrace.length; i += BATCH) {
        const batch = toStartGrace.slice(i, i + BATCH);
        await writeWithRetry(
          'MATCH (t:Tool) WHERE t.name IN $names SET t.grace_until = $until, t.grace_retries = 1',
          { names: batch, until: graceUntil },
        );
      }
      logger.info({ count: toStartGrace.length, graceUntil }, 'Started grace period');
    }

    for (const { name, retries } of toExtendGrace) {
      const graceUntil = addDays(GRACE_DAYS);
      await writeWithRetry(
        'MATCH (t:Tool { name: $name }) SET t.grace_until = $until, t.grace_retries = $retries',
        { name, until: graceUntil, retries: retries + 1 },
      );
    }
    if (toExtendGrace.length > 0)
      logger.info({ count: toExtendGrace.length }, 'Extended grace periods');

    logger.info('Cleanup complete');
  } finally {
    // session already closed above before writes; close driver regardless
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

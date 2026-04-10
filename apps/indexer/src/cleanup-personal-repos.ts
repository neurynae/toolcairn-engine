/**
 * Cleanup: remove low-quality personal repos from Memgraph.
 * A "personal repo" is one owned by a GitHub User (not an Organization).
 * We only keep personal repos with >= 1000 stars.
 *
 * Since owner_type is not stored on existing Tool nodes, this script:
 *  1. Fetches all tools with < 1000 stars from Memgraph
 *  2. Parses the owner from github_url
 *  3. Batch-queries GitHub API for each unique owner's type
 *  4. Collects tools to delete (owner is User AND stars < 1000)
 *  5. Deletes them in batches (with --dry-run to preview first)
 *
 * Usage:
 *   pnpm tsx src/cleanup-personal-repos.ts          # dry run (safe)
 *   pnpm tsx src/cleanup-personal-repos.ts --delete # actually delete
 *
 * Requires GITHUB_TOKEN in env for higher API rate limits.
 */

import { Octokit } from '@octokit/rest';
import { config } from '@toolcairn/config';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:cleanup-personal-repos' });
const DRY_RUN = !process.argv.includes('--delete');
const STAR_THRESHOLD = 1000;

/** Parse owner login from a GitHub URL: https://github.com/owner/repo → owner */
function parseOwner(githubUrl: string): string | null {
  try {
    const url = new URL(githubUrl);
    if (!url.hostname.includes('github.com')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  if (DRY_RUN) {
    logger.info('DRY RUN — pass --delete to actually remove tools');
  }

  const octokit = new Octokit({ auth: config.GITHUB_TOKEN });
  const session = getMemgraphSession();

  try {
    // 1. Fetch all tools with < STAR_THRESHOLD stars
    const result = await session.run(
      `MATCH (t:Tool)
       WHERE t.health_stars < $threshold
       RETURN t.name AS name, t.github_url AS github_url, t.health_stars AS stars`,
      { threshold: STAR_THRESHOLD },
    );

    const candidates = result.records.map((r) => {
      const rawStars = r.get('stars') as unknown;
      const stars =
        typeof rawStars === 'object' && rawStars !== null && 'toNumber' in rawStars
          ? (rawStars as { toNumber: () => number }).toNumber()
          : (rawStars as number);
      return {
        name: r.get('name') as string,
        github_url: r.get('github_url') as string,
        stars,
      };
    });

    logger.info({ count: candidates.length }, `Tools with < ${STAR_THRESHOLD} stars`);

    if (candidates.length === 0) {
      logger.info('Nothing to clean up');
      return;
    }

    // 2. Collect unique owners
    const ownerMap = new Map<string, string[]>(); // owner → tool names
    for (const tool of candidates) {
      const owner = parseOwner(tool.github_url);
      if (!owner) continue;
      const existing = ownerMap.get(owner) ?? [];
      existing.push(tool.name);
      ownerMap.set(owner, existing);
    }

    logger.info({ uniqueOwners: ownerMap.size }, 'Unique owners to check');

    // 3. Check remaining rate limit before starting — abort if < 500 requests left
    const { data: rateData } = await octokit.rateLimit.get();
    const remaining = rateData.resources.core.remaining;
    const resetAt = new Date(rateData.resources.core.reset * 1000).toISOString();
    logger.info({ remaining, resetAt }, 'GitHub rate limit before owner lookups');
    if (remaining < ownerMap.size + 100) {
      logger.error(
        { remaining, needed: ownerMap.size, resetAt },
        'Insufficient rate limit — aborting. Wait until reset and ensure the daily indexer is not running.',
      );
      return;
    }

    // 4. Query GitHub for each owner type — pause when rate limit drops below 200
    const userOwners = new Set<string>();
    let checked = 0;

    for (const [owner] of ownerMap) {
      try {
        const resp = await octokit.users.getByUsername({ username: owner });
        if (resp.data.type === 'User') {
          userOwners.add(owner);
        }

        // Check rate limit headers every 50 requests
        if (checked % 50 === 0) {
          const limitRemaining = Number(
            (resp.headers as Record<string, string>)['x-ratelimit-remaining'] ?? 9999,
          );
          const limitReset = Number(
            (resp.headers as Record<string, string>)['x-ratelimit-reset'] ?? 0,
          );
          if (limitRemaining < 200) {
            const waitMs = Math.max(0, limitReset * 1000 - Date.now()) + 5000;
            logger.warn(
              { limitRemaining, waitMs: Math.round(waitMs / 1000) + 's' },
              'Rate limit low — pausing until reset',
            );
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      } catch (e) {
        logger.warn({ owner, err: e }, 'Could not fetch owner info — skipping');
      }

      checked++;
      if (checked % 100 === 0) {
        logger.info({ checked, total: ownerMap.size }, 'Owner lookup progress');
      }
    }

    logger.info({ personalOwners: userOwners.size }, 'Personal (User) owners found');

    // 4. Collect tools to delete: owner is User AND stars < threshold
    const toDelete: string[] = [];
    for (const tool of candidates) {
      const owner = parseOwner(tool.github_url);
      if (owner && userOwners.has(owner)) {
        toDelete.push(tool.name);
      }
    }

    logger.info({ count: toDelete.length }, `Tools to ${DRY_RUN ? 'delete (dry run)' : 'delete'}`);

    if (toDelete.length === 0) {
      logger.info('No personal repos to remove');
      return;
    }

    if (DRY_RUN) {
      logger.info({ sample: toDelete.slice(0, 20) }, 'Sample of tools that would be deleted');
      logger.info('Re-run with --delete to remove them');
      return;
    }

    // 5. Delete in batches of 100
    const BATCH = 100;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      await session.run('MATCH (t:Tool) WHERE t.name IN $names DETACH DELETE t', { names: batch });
      deleted += batch.length;
      logger.info({ deleted, total: toDelete.length }, 'Deletion progress');
    }

    logger.info({ deleted }, 'Cleanup complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Smart restore: check GitHub stars via lightweight API call, only enqueue >= 1k.
 *
 * For each 'pending' tool in Postgres (from the bulk restore):
 *   1. Extract owner/repo from github_url
 *   2. Call GitHub API /repos/{owner}/{repo} (costs 1 API call, returns stars)
 *   3. If stars >= 1000: enqueue for full re-indexing
 *   4. If stars < 1000: set status to 'skipped' (don't waste a full crawl)
 *
 * Uses the dual-token pool for rate limiting.
 *
 * Usage:
 *   pnpm tsx src/restore-high-star-only.ts          # dry run
 *   pnpm tsx src/restore-high-star-only.ts --enqueue # enqueue high-star tools
 */

import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { enqueueIndexJob } from '@toolcairn/queue';
import { getBestCoreSlot } from './crawlers/rate-limit.js';

const logger = createLogger({ name: '@toolcairn/indexer:restore-high-star' });
const DRY_RUN = !process.argv.includes('--enqueue');
const STAR_THRESHOLD = 1000;

function parseOwnerRepo(githubUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(githubUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0] as string, repo: parts[1] as string };
  } catch {
    return null;
  }
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const pending = await prisma.indexedTool.findMany({
      where: { index_status: 'pending' },
      select: { id: true, github_url: true },
    });

    logger.info({ total: pending.length, dryRun: DRY_RUN }, 'Pending tools to check');

    let checked = 0;
    let enqueued = 0;
    let skipped = 0;
    let apiErrors = 0;

    for (const tool of pending) {
      const parsed = parseOwnerRepo(tool.github_url);
      if (!parsed) {
        skipped++;
        continue;
      }

      // Check rate limit every 100 tools
      if (checked % 100 === 0 && checked > 0) {
        const best = getBestCoreSlot();
        const remaining = best.core.remaining;
        logger.info(
          { checked, enqueued, skipped, apiErrors, remaining, total: pending.length },
          'Progress',
        );
        if (remaining < 200 && best.core.resetAt > 0) {
          const waitMs = Math.max(0, best.core.resetAt * 1000 - Date.now()) + 5000;
          logger.warn(
            { remaining, waitSecs: Math.round(waitMs / 1000) },
            'Rate limit low — pausing',
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      try {
        const slot = getBestCoreSlot();
        const resp = await slot.octokit.repos.get({
          owner: parsed.owner,
          repo: parsed.repo,
        });
        const stars = resp.data.stargazers_count;

        if (stars >= STAR_THRESHOLD) {
          if (!DRY_RUN) {
            await enqueueIndexJob(tool.github_url, 0);
          }
          enqueued++;
          if (enqueued <= 50) {
            logger.info({ url: tool.github_url, stars }, DRY_RUN ? 'Would enqueue' : 'Enqueued');
          }
        } else {
          if (!DRY_RUN) {
            await prisma.indexedTool.update({
              where: { id: tool.id },
              data: { index_status: 'skipped', updated_at: new Date() },
            });
          }
          skipped++;
        }
      } catch (e) {
        // 404 = repo deleted/private, skip it
        const status = (e as { status?: number }).status;
        if (status === 404) {
          if (!DRY_RUN) {
            await prisma.indexedTool.update({
              where: { id: tool.id },
              data: { index_status: 'skipped', updated_at: new Date() },
            });
          }
          skipped++;
        } else {
          apiErrors++;
          if (apiErrors <= 10) {
            logger.warn({ url: tool.github_url, err: e }, 'API error');
          }
        }
      }

      checked++;
    }

    logger.info(
      { checked, enqueued, skipped, apiErrors },
      DRY_RUN ? 'Dry run complete' : 'Restore complete',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Run the reindex scheduler once.
 * Finds tools with stale health signals and enqueues low-priority re-index jobs.
 *
 * Usage:
 *   pnpm tsx src/run-reindex.ts
 *
 * Can be run periodically via cron:
 *   0 2 * * * cd /path/to/ToolPilot && pnpm tsx apps/indexer/src/run-reindex.ts
 */

import { createLogger } from '@toolcairn/errors';
import { runReindexScheduler } from './schedulers/reindex-scheduler.js';

const logger = createLogger({ name: '@toolcairn/indexer:run-reindex' });

async function main() {
  logger.info('Starting scheduled reindex run');
  try {
    const { found, enqueued } = await runReindexScheduler();
    logger.info({ found, enqueued }, 'Reindex run complete');
    process.exit(0);
  } catch (e) {
    logger.error({ err: e }, 'Reindex run failed');
    process.exit(1);
  }
}

main();

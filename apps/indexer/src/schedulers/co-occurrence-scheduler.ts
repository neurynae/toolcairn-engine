/**
 * Co-occurrence Scheduler — runs daily.
 *
 * Gate: only runs when there are 1,000+ completed SearchSessions.
 * Below that threshold, the data is too sparse to produce meaningful edges.
 */

import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { processCoOccurrences } from '../processors/co-occurrence-processor.js';

const logger = createLogger({ name: '@toolcairn/indexer:co-occurrence-scheduler' });
const MIN_SESSIONS_GATE = 1_000;

export async function runCoOccurrenceScheduler(): Promise<void> {
  // Gate: check total completed sessions
  const count = await prisma.searchSession.count({ where: { status: 'completed' } });

  if (count < MIN_SESSIONS_GATE) {
    logger.debug(
      { count, required: MIN_SESSIONS_GATE },
      'Co-occurrence gate not met — skipping (need more sessions)',
    );
    return;
  }

  // Check how many unprocessed sessions exist
  const unprocessed = await prisma.searchSession.count({
    where: { status: 'completed', co_occurrence_processed: false },
  });

  if (unprocessed === 0) {
    logger.debug('No unprocessed sessions — co-occurrence up to date');
    return;
  }

  logger.info({ unprocessed, totalSessions: count }, 'Running co-occurrence processor');
  const result = await processCoOccurrences(500);
  logger.info(result, 'Co-occurrence scheduler complete');
}

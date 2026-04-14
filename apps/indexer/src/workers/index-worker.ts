import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import {
  enqueueDiscoveryTrigger,
  enqueueReindexTrigger,
  enqueueSearchEvent,
  startConsumer,
} from '@toolcairn/queue';
import type { QueueHandlers } from '@toolcairn/queue';
import { getRateLimitStatus, refreshRateLimitsFromGitHub } from '../crawlers/github-discovery.js';
import { handleIndexJob } from '../queue-consumers/index-consumer.js';
import { runDiscoveryScheduler } from '../schedulers/discovery-scheduler.js';
import { runPendingWatchdog } from '../schedulers/pending-watchdog.js';
import { runReindexScheduler } from '../schedulers/reindex-scheduler.js';

const logger = createLogger({ name: '@toolcairn/indexer:index-worker' });

/** How often the cron loop wakes up to check whether schedulers are due. */
const CRON_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/** Reindex runs on tools older than this many days. */
const REINDEX_STALE_DAYS = 7;

/**
 * Internal cron loop — reads admin settings every hour and fires scheduler
 * triggers when they are due. Respects the enabled/disabled toggles in AppSettings
 * so admins can turn auto-discovery and auto-reindex on/off from the UI.
 */
async function startSchedulerCron(): Promise<void> {
  const prisma = new PrismaClient();

  const tick = async () => {
    try {
      const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });

      // Check rate limit budget before any triggers
      const rateStatus = getRateLimitStatus();
      logger.debug(
        {
          core: `${rateStatus.core.remaining}/${rateStatus.core.limit} (${rateStatus.core.pct}%)`,
          maxTools: rateStatus.maxIndexableTools,
        },
        'Cron: rate limit status',
      );

      // ── Discovery ──────────────────────────────────────────────────────────
      if (settings?.discovery_scheduler_enabled) {
        const intervalHours = settings.discovery_interval_hours ?? 24;
        const batchSize = settings.discovery_batch_size ?? 20;
        const lastRun = settings.last_discovery_run;
        const hoursSinceLast = lastRun
          ? (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60)
          : Number.POSITIVE_INFINITY;

        if (hoursSinceLast >= intervalHours) {
          // Gate: ensure enough Core API budget to crawl the full discovery batch
          // Discovery: batchSize tools × ~5 calls each + 20% safety headroom
          const neededForDiscovery = Math.ceil(batchSize * 5 * 1.2);
          if (rateStatus.maxIndexableTools >= batchSize) {
            logger.info(
              { intervalHours, hoursSinceLast: Math.round(hoursSinceLast), budgetOk: true },
              'Cron: triggering discovery',
            );
            const result = await enqueueDiscoveryTrigger();
            if (!result.ok)
              logger.warn({ error: result.error }, 'Cron: failed to enqueue discovery trigger');
          } else {
            logger.warn(
              {
                needed: neededForDiscovery,
                remaining: rateStatus.core.remaining,
                maxTools: rateStatus.maxIndexableTools,
              },
              'Cron: skipping discovery — insufficient rate limit budget',
            );
          }
        }
      }

      // ── Reindex ────────────────────────────────────────────────────────────
      if (settings?.reindex_scheduler_enabled ?? true) {
        const lastRun = settings?.last_reindex_run;
        const daysSinceLast = lastRun
          ? (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24)
          : Number.POSITIVE_INFINITY;

        if (daysSinceLast >= REINDEX_STALE_DAYS) {
          // Gate: need at least 50 tool budget (reindex scheduler caps at 50 per batch)
          if (rateStatus.maxIndexableTools >= 50) {
            logger.info({ daysSinceLast: Math.round(daysSinceLast) }, 'Cron: triggering reindex');
            const result = await enqueueReindexTrigger();
            if (!result.ok)
              logger.warn({ error: result.error }, 'Cron: failed to enqueue reindex trigger');
          } else {
            logger.warn(
              { remaining: rateStatus.core.remaining, maxTools: rateStatus.maxIndexableTools },
              'Cron: skipping reindex — insufficient rate limit budget',
            );
          }
        }
      }
      // ── Pending watchdog ───────────────────────────────────────────────────
      try {
        const watchdogResult = await runPendingWatchdog(prisma);
        if (watchdogResult.requeued > 0) {
          logger.info(watchdogResult, 'Cron: pending watchdog re-queued stuck tools');
        }
      } catch (err) {
        logger.warn({ err }, 'Cron: pending watchdog failed — will retry next tick');
      }

      // ── Weekly email digest ────────────────────────────────────────────────
      try {
        const { runDigestScheduler } = await import('../schedulers/digest-scheduler.js');
        await runDigestScheduler();
      } catch (err) {
        logger.warn({ err }, 'Cron: digest scheduler failed — non-fatal');
      }

      // ── Collaborative filtering (co-occurrence edges) ─────────────────────
      // Gated to 1000+ sessions; runs daily when unprocessed sessions exist
      try {
        const { runCoOccurrenceScheduler } = await import(
          '../schedulers/co-occurrence-scheduler.js'
        );
        await runCoOccurrenceScheduler();
      } catch (err) {
        logger.warn({ err }, 'Cron: co-occurrence scheduler failed — non-fatal');
      }
    } catch (err) {
      logger.warn({ err }, 'Cron tick failed — will retry next interval');
    }
  };

  // Run immediately on startup (catches up if worker was restarted after a long pause)
  await tick();

  // Then run every CRON_POLL_INTERVAL_MS
  setInterval(tick, CRON_POLL_INTERVAL_MS);
  logger.info({ pollIntervalHours: CRON_POLL_INTERVAL_MS / 3_600_000 }, 'Scheduler cron started');
}
async function logSearchEvent(query: string, sessionId: string): Promise<void> {
  const result = await enqueueSearchEvent(query, sessionId);
  if (!result.ok) {
    logger.warn({ query, sessionId, error: result.error }, 'Failed to enqueue search event');
  }
}

async function runDiscovery(): Promise<void> {
  logger.info('Received run-discovery trigger');
  try {
    const result = await runDiscoveryScheduler();
    logger.info(result, 'Discovery scheduler completed');
  } catch (err) {
    logger.error({ err }, 'Discovery scheduler failed');
  }
}

async function runReindex(force?: boolean): Promise<void> {
  logger.info({ force: !!force }, 'Received run-reindex trigger');
  try {
    const result = await runReindexScheduler(force);
    logger.info(result, 'Reindex scheduler completed');
  } catch (err) {
    logger.error({ err }, 'Reindex scheduler failed');
  }
}

/**
 * Start the index worker — connects to Redis and begins consuming queue messages.
 * Also handles scheduler triggers (run-discovery, run-reindex).
 */
export async function startIndexWorker(): Promise<void> {
  logger.info('Starting index worker');

  // Prime rate limit state from GitHub before any crawl work begins.
  // Prevents the indexer from over-assuming quota on restart (in-memory state
  // resets to defaults; this call fetches the actual remaining from the API).
  await refreshRateLimitsFromGitHub();

  // Start the scheduler cron in the background (non-blocking)
  startSchedulerCron().catch((err) => {
    logger.error({ err }, 'Scheduler cron failed to start');
  });

  const handlers: QueueHandlers = {
    onIndexJob: handleIndexJob,
    onSearchEvent: logSearchEvent,
    onRunDiscovery: runDiscovery,
    onRunReindex: runReindex,
  };

  // INDEXER_IDLE_EXIT_MINUTES: when set, exit after queue has been empty for this
  // many minutes. Used by CI one-shot runs so the job terminates once all work drains.
  // Leave unset for the persistent daemon (never auto-exits on empty queue).
  const idleExitMinutes = process.env.INDEXER_IDLE_EXIT_MINUTES
    ? Number(process.env.INDEXER_IDLE_EXIT_MINUTES)
    : undefined;
  const idleExitMs = idleExitMinutes ? idleExitMinutes * 60_000 : undefined;

  if (idleExitMs) {
    logger.info({ idleExitMinutes }, 'Idle-exit mode enabled — will stop when queue is empty');
  }

  await startConsumer(handlers, { idleExitMs });
}

// Daily retention cron — prunes rows that have outlived their usefulness so
// the tables don't grow unbounded.
//
// Retention policy:
//   MagicLinkToken      30 days after expiresAt (already-used links need a
//                       short grace period so "this link was already used"
//                       error pages still work if the user double-clicks).
//   EmailOutbox         30 days after processedAt (any operational forensics
//                       window). EmailEvent has the long-term audit trail.
//   ScheduledEmail      30 days after releasedAt.
//
// EmailEvent itself is NEVER pruned here — it's the idempotency + audit log,
// needed for admin history queries and bounce attribution.
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/api:data-retention' });

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 30;
// Run at 03:00 UTC to avoid peak-hour Postgres load. The interval check
// below guards against drift across container restarts.
const RUN_HOUR_UTC = 3;
const MIN_INTERVAL_MS = 12 * 3600 * 1000; // don't run twice in 12h

let lastRunAt: number | null = null;
let timer: NodeJS.Timeout | undefined;

async function runOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
  try {
    const [tokens, outbox, scheduled] = await Promise.all([
      prisma.magicLinkToken.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      }),
      prisma.emailOutbox.deleteMany({
        where: { processedAt: { not: null, lt: cutoff } },
      }),
      prisma.scheduledEmail.deleteMany({
        where: { releasedAt: { not: null, lt: cutoff } },
      }),
    ]);
    logger.info(
      {
        magicLinkTokens: tokens.count,
        emailOutbox: outbox.count,
        scheduledEmail: scheduled.count,
        cutoff: cutoff.toISOString(),
      },
      'data-retention tick complete',
    );
  } catch (e) {
    logger.error({ err: e }, 'data-retention tick failed');
  }
}

function maybeRun(): void {
  const now = new Date();
  if (now.getUTCHours() !== RUN_HOUR_UTC) return;
  if (lastRunAt && Date.now() - lastRunAt < MIN_INTERVAL_MS) return;
  lastRunAt = Date.now();
  void runOnce();
}

/** Start the retention loop. Checks every 10 minutes — fires once/day at 03:00 UTC. */
export function startDataRetentionPoller(): void {
  if (timer) return;
  logger.info(
    { runHourUtc: RUN_HOUR_UTC, retentionDays: RETENTION_DAYS },
    'data-retention-poller started',
  );
  // Wait a minute before the first check so startup isn't front-loaded.
  setTimeout(() => {
    maybeRun();
    timer = setInterval(maybeRun, 10 * 60 * 1000);
  }, 60_000);
}

export function stopDataRetentionPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

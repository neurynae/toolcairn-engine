// Scheduled-email poller — releases ScheduledEmail rows whose runAt has passed
// into EmailOutbox. Runs every 60 seconds. The outbox-poller then picks them
// up on its next tick (typically within 1s) and XADDs to Redis.
//
// Used for delayed notifications: pro-expiring T-7d, waitlist-grant T+30d,
// welcome-series day-3/7 (future).
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/api:scheduled-email-poller' });

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 200;

let timer: NodeJS.Timeout | undefined;
let running = false;

async function releaseOnce(): Promise<void> {
  const due = await prisma.scheduledEmail.findMany({
    where: { releasedAt: null, runAt: { lte: new Date() } },
    take: BATCH_SIZE,
    orderBy: { runAt: 'asc' },
  });
  if (due.length === 0) return;

  for (const row of due) {
    try {
      await prisma.$transaction(async (tx) => {
        // Re-check releasedAt under tx to guard against double-release across pollers
        const fresh = await tx.scheduledEmail.findUnique({ where: { id: row.id } });
        if (!fresh || fresh.releasedAt) return;

        await tx.emailOutbox.create({
          data: {
            kind: row.kind,
            userId: row.userId,
            toEmail: row.toEmail,
            scopeKey: row.scopeKey,
            payload: row.payload as unknown as object,
          },
        });
        await tx.scheduledEmail.update({
          where: { id: row.id },
          data: { releasedAt: new Date() },
        });
      });
    } catch (e) {
      logger.warn({ err: e, scheduledEmailId: row.id }, 'scheduled-email release failed');
    }
  }
  logger.info({ released: due.length }, 'scheduled-email-poller released rows');
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await releaseOnce();
  } catch (e) {
    logger.error({ err: e }, 'scheduled-email-poller tick failed');
  } finally {
    running = false;
  }
}

export function startScheduledEmailPoller(): void {
  if (timer) return;
  logger.info({ intervalMs: INTERVAL_MS }, 'scheduled-email-poller started');
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), INTERVAL_MS);
  }, 5000);
}

export function stopScheduledEmailPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

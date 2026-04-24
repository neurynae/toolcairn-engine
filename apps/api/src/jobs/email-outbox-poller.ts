// Outbox poller — drains the EmailOutbox table into the `email-jobs` Redis
// stream. Runs in the API container (colocated with Postgres writes) on a 1s
// tick. Idempotent: if XADD succeeds but the processedAt update fails, the
// next tick re-enqueues and the consumer's dedup guard catches it.
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { xaddEmailJob } from '@toolcairn/notifications';
import type { EmailKindValue } from '@toolcairn/notifications';
import { Redis } from 'ioredis';

const logger = createLogger({ name: '@toolcairn/api:email-outbox-poller' });

const INTERVAL_MS = 1000;
const BATCH_SIZE = 100;

let redisClient: Redis | undefined;
let timer: NodeJS.Timeout | undefined;
let running = false;

function getRedis(): Redis {
  if (!redisClient) redisClient = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

async function drainOnce(): Promise<void> {
  if (!config.NOTIFICATIONS_ENABLED) return;
  const rows = await prisma.emailOutbox.findMany({
    where: {
      processedAt: null,
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return;

  const redis = getRedis();
  for (const row of rows) {
    try {
      await xaddEmailJob(redis, row.id, row.userId, row.kind as EmailKindValue);
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
    } catch (e) {
      logger.warn({ err: e, outboxId: row.id }, 'outbox drain: XADD failed, will retry next tick');
    }
  }
  if (rows.length > 0) {
    logger.debug({ drained: rows.length }, 'email-outbox tick drained');
  }
}

async function tick(): Promise<void> {
  if (running) return; // drop overlapping ticks
  running = true;
  try {
    await drainOnce();
  } catch (e) {
    logger.error({ err: e }, 'email-outbox-poller tick failed');
  } finally {
    running = false;
  }
}

export function startEmailOutboxPoller(): void {
  if (timer) return;
  logger.info({ intervalMs: INTERVAL_MS }, 'email-outbox-poller started');
  // Delay the first run a few seconds to let the rest of startup settle
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), INTERVAL_MS);
  }, 3000);
}

export function stopEmailOutboxPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

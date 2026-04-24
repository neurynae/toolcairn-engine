// Email worker — consumes the `email-jobs` Redis stream via a consumer group
// and drives each job through the 10-step processing pipeline. One instance
// runs inside the indexer container. Shutdown is graceful on SIGTERM.
//
// Pipeline (per plan):
//   1. Dedup (EmailEvent)
//   2. Suppression (EmailSuppression)
//   3. Per-kind preference + global opt-out
//   4. Per-user daily cap
//   5. Circuit breaker
//   6. Rate-limit token
//   7. Render template
//   8. POST Resend w/ idempotency key
//   9. Upsert EmailEvent
//  10. XACK (retry/DLQ on 5xx/429/network)
import { randomUUID } from 'node:crypto';
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { ErrorCode, createLogger } from '@toolcairn/errors';
import { Redis } from 'ioredis';
import { renderTemplate } from '../templates/index.js';
import { sendEmail } from '../transport/resend.js';
import { EmailKind, type EmailKindValue, KIND_PREFERENCE_GATE } from '../types.js';
import { isCircuitOpen, recordOutcome } from './circuit.js';
import { acquireRateLimitToken } from './rate-limit.js';
import { buildEmailContext } from './render-context.js';

const logger = createLogger({ name: '@toolcairn/notifications:worker' });

const STREAM = 'email-jobs';
const DEAD_STREAM = 'email-jobs-dead';
const GROUP = 'email-workers';
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const DAILY_CAP_PER_USER = 5;
const JOB_TIMEOUT_MS = 60_000;

let redisSingleton: Redis | undefined;

function getRedis(): Redis {
  if (!redisSingleton) {
    redisSingleton = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisSingleton;
}

async function ensureGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('BUSYGROUP')) throw e;
  }
}

export interface RunEmailWorkerOptions {
  /** When set, worker exits after this many consecutive empty polls. Useful for one-shot CI. */
  idleExitEmptyPolls?: number;
}

/**
 * Enqueue a job onto the stream. Called by the outbox-poller in the API container;
 * the consumer loop drains from this stream.
 */
export async function xaddEmailJob(
  redis: Redis,
  outboxId: string,
  userId: string | null,
  kind: EmailKindValue,
): Promise<string> {
  return redis.xadd(
    STREAM,
    '*',
    'outboxId',
    outboxId,
    'userId',
    userId ?? '',
    'kind',
    kind,
    'enqueuedAt',
    String(Date.now()),
  ) as Promise<string>;
}

interface StreamJob {
  entryId: string;
  outboxId: string;
  userId: string | null;
  kind: EmailKindValue;
  enqueuedAt: number;
}

function parseFields(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) map[k] = v;
  }
  return map;
}

async function readJobs(
  redis: Redis,
  consumer: string,
  count: number,
  blockMs: number,
): Promise<StreamJob[]> {
  const result = (await redis.xreadgroup(
    'GROUP',
    GROUP,
    consumer,
    'COUNT',
    String(count),
    'BLOCK',
    String(blockMs),
    'STREAMS',
    STREAM,
    '>',
  )) as [string, [string, string[]][]][] | null;

  if (!result) return [];
  const jobs: StreamJob[] = [];
  for (const [, entries] of result) {
    for (const [entryId, fields] of entries) {
      const map = parseFields(fields);
      if (!map.outboxId || !map.kind) continue;
      jobs.push({
        entryId,
        outboxId: map.outboxId,
        userId: map.userId && map.userId.length > 0 ? map.userId : null,
        kind: map.kind as EmailKindValue,
        enqueuedAt: Number.parseInt(map.enqueuedAt ?? '0', 10) || 0,
      });
    }
  }
  return jobs;
}

async function moveToDLQ(redis: Redis, job: StreamJob, reason: string): Promise<void> {
  await redis.xadd(
    DEAD_STREAM,
    '*',
    'outboxId',
    job.outboxId,
    'userId',
    job.userId ?? '',
    'kind',
    job.kind,
    'reason',
    reason,
    'deadAt',
    String(Date.now()),
  );
}

function delayForAttempt(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 3_600_000;
}

async function processJob(job: StreamJob): Promise<void> {
  const redis = getRedis();

  // Master kill switch — audit only, do not send.
  if (!config.NOTIFICATIONS_ENABLED) {
    logger.warn(
      { outboxId: job.outboxId, kind: job.kind },
      'NOTIFICATIONS_ENABLED=false — skipping send, acking job',
    );
    await redis.xack(STREAM, GROUP, job.entryId);
    return;
  }

  const outbox = await prisma.emailOutbox.findUnique({ where: { id: job.outboxId } });
  if (!outbox) {
    // outbox row disappeared — probably manually purged. Ack and move on.
    await redis.xack(STREAM, GROUP, job.entryId);
    return;
  }
  const { userId, toEmail, kind, scopeKey, payload, requestId } = outbox;
  const kindValue = kind as EmailKindValue;

  // 1. Dedup by (userId, kind, scopeKey)
  if (userId) {
    const existing = await prisma.emailEvent.findUnique({
      where: { userId_kind_scopeKey: { userId, kind, scopeKey } },
      select: { status: true, id: true },
    });
    if (existing && ['sent', 'delivered'].includes(existing.status)) {
      await redis.xack(STREAM, GROUP, job.entryId);
      return;
    }
  }

  // 2. Suppression
  const suppressed = await prisma.emailSuppression.findUnique({ where: { email: toEmail } });
  if (suppressed) {
    await recordEventTerminal(
      outbox.id,
      userId,
      toEmail,
      kindValue,
      scopeKey,
      requestId,
      'suppressed',
      'ERR_EMAIL_SUPPRESSED',
      `address suppressed: ${suppressed.reason}`,
    );
    await redis.xack(STREAM, GROUP, job.entryId);
    return;
  }

  // 3. Per-kind preference + global opt-out
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        emailDoNotEmail: true,
        notifyLimitAlerts: true,
        notifyReleases: true,
        notifyBilling: true,
        emailDigestEnabled: true,
      },
    });
    if (!user) {
      await recordEventTerminal(
        outbox.id,
        userId,
        toEmail,
        kindValue,
        scopeKey,
        requestId,
        'failed',
        'ERR_DB_NOT_FOUND',
        'user not found',
      );
      await redis.xack(STREAM, GROUP, job.entryId);
      return;
    }
    if (user.emailDoNotEmail) {
      await recordEventTerminal(
        outbox.id,
        userId,
        toEmail,
        kindValue,
        scopeKey,
        requestId,
        'suppressed',
        'ERR_EMAIL_DO_NOT_EMAIL',
        'user globally opted out',
      );
      await redis.xack(STREAM, GROUP, job.entryId);
      return;
    }
    const gate = KIND_PREFERENCE_GATE[kindValue];
    if (gate) {
      const flagValue = user[gate];
      // emailDigestEnabled defaults FALSE → user must opt in; the others default TRUE → opt out.
      const allowed = gate === 'emailDigestEnabled' ? flagValue === true : flagValue !== false;
      if (!allowed) {
        await recordEventTerminal(
          outbox.id,
          userId,
          toEmail,
          kindValue,
          scopeKey,
          requestId,
          'suppressed',
          'ERR_EMAIL_PREFERENCE',
          `user opted out of ${kindValue}`,
        );
        await redis.xack(STREAM, GROUP, job.entryId);
        return;
      }
    }

    // 4. Per-user daily cap
    const since = new Date(Date.now() - 24 * 3600_000);
    const todayCount = await prisma.emailEvent.count({
      where: {
        userId,
        status: { in: ['sent', 'delivered'] },
        createdAt: { gte: since },
      },
    });
    if (todayCount >= DAILY_CAP_PER_USER) {
      logger.warn({ userId, kind: kindValue, todayCount }, 'per-user daily cap reached — acking');
      await recordEventTerminal(
        outbox.id,
        userId,
        toEmail,
        kindValue,
        scopeKey,
        requestId,
        'capped',
        'ERR_EMAIL_DAILY_CAP',
        `daily cap ${DAILY_CAP_PER_USER} reached`,
      );
      await redis.xack(STREAM, GROUP, job.entryId);
      return;
    }

    // 5. Circuit breaker — xclaim-back by not XACKing
    if (await isCircuitOpen(redis)) {
      logger.warn({ outboxId: outbox.id }, 'circuit open — leaving job pending for later reclaim');
      return;
    }

    // 6. Rate limit
    const gotToken = await acquireRateLimitToken(redis, {
      sendsPerSecond: config.RESEND_RATE_LIMIT,
    });
    if (!gotToken) {
      logger.warn({ outboxId: outbox.id }, 'rate-limit token wait exceeded — leaving pending');
      return;
    }

    // 7 + 8. Render + send
    const eventId = randomUUID();
    const ctx = await buildEmailContext({
      prisma,
      userId,
      toEmail,
      kind: kindValue,
      payload: payload as Record<string, unknown>,
      name: user.name,
    });
    const rendered = renderTemplate(kindValue, ctx);
    const unsubHttps = ctx.unsubscribeUrl ?? `${config.PUBLIC_APP_URL}/settings/notifications`;
    const outcome = await sendEmail({
      to: toEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: eventId,
      headers: {
        'List-Unsubscribe': `<mailto:unsubscribe+${userId}@neurynae.com>, <${unsubHttps}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        ...(kindValue === EmailKind.McpRelease || kindValue === EmailKind.WeeklyDigest
          ? { Precedence: 'bulk' }
          : {}),
      },
      tags: [
        { name: 'kind', value: kindValue },
        { name: 'env', value: config.TOOLPILOT_MODE },
        { name: 'userId', value: userId },
        ...(requestId ? [{ name: 'requestId', value: requestId }] : []),
      ],
    });

    await recordOutcome(redis, outcome.ok);

    if (outcome.ok && outcome.providerMessageId) {
      // 9. Mark success
      await prisma.emailEvent.upsert({
        where: { userId_kind_scopeKey: { userId, kind: kindValue, scopeKey } },
        create: {
          id: eventId,
          userId,
          toEmail,
          kind: kindValue,
          scopeKey,
          requestId,
          outboxId: outbox.id,
          providerMessageId: outcome.providerMessageId,
          status: 'sent',
          sentAt: new Date(),
        },
        update: {
          providerMessageId: outcome.providerMessageId,
          status: 'sent',
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      await prisma.emailOutbox.update({
        where: { id: outbox.id },
        data: { processedAt: new Date() },
      });
      await redis.xack(STREAM, GROUP, job.entryId);
      return;
    }

    // 10. Failure path
    const newAttempts = outbox.attempts + 1;
    await prisma.emailOutbox.update({
      where: { id: outbox.id },
      data: { attempts: newAttempts },
    });
    if (!outcome.retriable || newAttempts >= MAX_ATTEMPTS) {
      await recordEventTerminal(
        outbox.id,
        userId,
        toEmail,
        kindValue,
        scopeKey,
        requestId,
        'failed',
        outcome.errorCode ?? ErrorCode.ERR_EXTERNAL_RESEND,
        outcome.errorMessage ?? 'send failed',
      );
      await moveToDLQ(redis, job, outcome.errorMessage ?? 'send failed');
      await redis.xack(STREAM, GROUP, job.entryId);
      logger.error(
        { outboxId: outbox.id, attempts: newAttempts, errorCode: outcome.errorCode },
        'email send failed terminally — moved to DLQ',
      );
      return;
    }
    // Retriable — leave pending for XAUTOCLAIM-based retry after backoff. Log and return.
    logger.warn(
      {
        outboxId: outbox.id,
        attempts: newAttempts,
        nextBackoffMs: delayForAttempt(newAttempts - 1),
        errorCode: outcome.errorCode,
      },
      'email send retriable failure — will reclaim after backoff',
    );
    return;
  }

  // No userId — rare (waitlist-from-logged-out flow doesn't go through outbox currently).
  // Treat as terminal; mark outbox processed to avoid re-enqueue loops.
  logger.warn({ outboxId: outbox.id, kind }, 'email without userId — not supported');
  await prisma.emailOutbox.update({
    where: { id: outbox.id },
    data: { processedAt: new Date() },
  });
  await redis.xack(STREAM, GROUP, job.entryId);
}

async function recordEventTerminal(
  outboxId: string,
  userId: string | null,
  toEmail: string,
  kind: EmailKindValue,
  scopeKey: string,
  requestId: string | null,
  status: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  if (userId) {
    await prisma.emailEvent.upsert({
      where: { userId_kind_scopeKey: { userId, kind, scopeKey } },
      create: {
        userId,
        toEmail,
        kind,
        scopeKey,
        requestId,
        outboxId,
        status,
        errorCode,
        errorMessage,
      },
      update: { status, errorCode, errorMessage },
    });
  }
  await prisma.emailOutbox.update({
    where: { id: outboxId },
    data: { processedAt: new Date() },
  });
}

/**
 * Consumer loop entry point. Call from the indexer process startup.
 * Runs until SIGTERM / SIGINT.
 */
export async function runEmailWorker(options: RunEmailWorkerOptions = {}): Promise<void> {
  const redis = getRedis();
  const consumer = `email-worker-${process.env.HOSTNAME ?? randomUUID()}`;
  await ensureGroup(redis, STREAM, GROUP);

  let running = true;
  let emptyPolls = 0;

  const shutdown = () => {
    running = false;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.info({ consumer, stream: STREAM }, 'email-worker started');

  try {
    while (running) {
      const jobs = await readJobs(redis, consumer, 10, 5000);
      if (jobs.length === 0) {
        emptyPolls++;
        if (options.idleExitEmptyPolls !== undefined && emptyPolls >= options.idleExitEmptyPolls) {
          logger.info({ emptyPolls }, 'email-worker idle-exit');
          break;
        }
        continue;
      }
      emptyPolls = 0;
      for (const job of jobs) {
        try {
          await withTimeout(processJob(job), JOB_TIMEOUT_MS);
        } catch (e) {
          logger.error({ err: e, entryId: job.entryId, outboxId: job.outboxId }, 'job crashed');
        }
      }
    }
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    logger.info('email-worker stopped');
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

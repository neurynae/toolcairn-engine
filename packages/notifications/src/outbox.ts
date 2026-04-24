// Outbox enqueue helper. Writes either an EmailOutbox row (immediate send) or a
// ScheduledEmail row (delayed send) and returns the row id. Never hits Redis;
// never talks to Resend. A separate poller in apps/api drains EmailOutbox into
// the Redis stream; the consumer in apps/indexer pops and sends.
//
// Call INSIDE a transaction when the trigger is a DB state change (user.create,
// plan='pro', etc.) so the enqueue commits atomically with the source write —
// this is the transactional outbox pattern. If the handler crashes between
// commit and XADD, the next outbox-poller tick re-enqueues.
import type { PrismaClient } from '@toolcairn/db';
import { ErrorCode, ValidationError, createLogger } from '@toolcairn/errors';
import type { EnqueueOptions } from './types.js';

const logger = createLogger({ name: '@toolcairn/notifications:outbox' });

// Accepts either the top-level PrismaClient or a tx-scoped client. The tx client
// is structurally a subset of PrismaClient (lacking $transaction/$connect/etc.);
// we only use the model delegates, so Omit'ing the root-only methods matches both.
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
type PrismaLike = PrismaClient | TxClient;

export interface EnqueueResult {
  /** null when suppression or preference gates short-circuited the enqueue. */
  outboxId: string | null;
  scheduledEmailId: string | null;
  status: 'queued' | 'scheduled' | 'suppressed';
}

function lowercaseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValidEmail(email: string): void {
  // RFC5322 is famously regex-hostile; this is a pragmatic validator that catches
  // the common shapes (has @, at least one dot in the domain). Deeper validation
  // happens at render time and at the provider.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError({
      code: ErrorCode.ERR_VALIDATION_INPUT,
      message: 'Invalid email address',
      context: { module: '@toolcairn/notifications', operation: 'enqueueEmail' },
    });
  }
}

/**
 * Enqueue an email.
 *
 * - Consults `EmailSuppression` first → returns `{ status: 'suppressed' }` without writing anywhere.
 * - Dedup against `EmailEvent (userId, kind, scopeKey)` — if already 'sent'/'delivered', returns suppressed.
 * - For immediate sends: writes `EmailOutbox`. The outbox poller XADDs to the `email-jobs` stream.
 * - For delayed sends (`scheduledFor` set): writes `ScheduledEmail`. The scheduled poller releases at runAt.
 */
export async function enqueueEmail(
  prisma: PrismaLike,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const toEmail = lowercaseEmail(opts.toEmail);
  assertValidEmail(toEmail);

  const scopeKey = opts.scopeKey ?? '';
  const payload = opts.payload ?? {};

  // Suppression check
  const suppressed = await prisma.emailSuppression.findUnique({ where: { email: toEmail } });
  if (suppressed) {
    logger.info(
      { userId: opts.userId, kind: opts.kind, scopeKey, reason: suppressed.reason },
      'enqueueEmail → suppressed (address on suppression list)',
    );
    // Audit: record the suppressed attempt so admin UI can surface it.
    if (opts.userId) {
      await prisma.emailEvent
        .upsert({
          where: {
            userId_kind_scopeKey: { userId: opts.userId, kind: opts.kind, scopeKey },
          },
          create: {
            userId: opts.userId,
            toEmail,
            kind: opts.kind,
            scopeKey,
            requestId: opts.requestId ?? null,
            status: 'suppressed',
            errorCode: 'ERR_EMAIL_SUPPRESSED',
            errorMessage: `address suppressed: ${suppressed.reason}`,
          },
          update: {}, // no-op — keep existing audit if it exists
        })
        .catch((e: unknown) =>
          logger.warn({ err: e }, 'suppression audit upsert failed (non-fatal)'),
        );
    }
    return { outboxId: null, scheduledEmailId: null, status: 'suppressed' };
  }

  // Prior-send dedup — if the scope key already has a delivered/sent row, skip.
  if (opts.userId) {
    const existing = await prisma.emailEvent.findUnique({
      where: {
        userId_kind_scopeKey: { userId: opts.userId, kind: opts.kind, scopeKey },
      },
      select: { status: true },
    });
    if (existing && ['sent', 'delivered'].includes(existing.status)) {
      return { outboxId: null, scheduledEmailId: null, status: 'suppressed' };
    }
  }

  // Delayed send
  if (opts.scheduledFor) {
    const row = await prisma.scheduledEmail.create({
      data: {
        runAt: opts.scheduledFor,
        kind: opts.kind,
        userId: opts.userId ?? null,
        toEmail,
        scopeKey,
        payload: payload as unknown as object,
      },
    });
    return { outboxId: null, scheduledEmailId: row.id, status: 'scheduled' };
  }

  // Immediate send — write to outbox
  const row = await prisma.emailOutbox.create({
    data: {
      kind: opts.kind,
      userId: opts.userId ?? null,
      toEmail,
      scopeKey,
      payload: payload as unknown as object,
      requestId: opts.requestId ?? null,
    },
  });
  return { outboxId: row.id, scheduledEmailId: null, status: 'queued' };
}

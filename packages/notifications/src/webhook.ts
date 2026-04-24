// Resend webhook handler — verifies svix HMAC, updates EmailEvent state, and
// populates the suppression list on hard bounces / complaints.
//
// Resend signs webhooks with the svix library format; headers:
//   svix-id, svix-timestamp, svix-signature
// Dashboard setting: RESEND_WEBHOOK_SECRET must be identical to the secret in Resend.
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { Webhook } from 'svix';

const logger = createLogger({ name: '@toolcairn/notifications:webhook' });

export interface ResendWebhookEvent {
  type: string; // email.sent | email.delivered | email.bounced | email.complained | email.delivery_delayed | email.opened | email.clicked
  created_at: string;
  data: {
    email_id: string;
    to?: string[];
    from?: string;
    subject?: string;
    bounce?: { type?: string; message?: string };
    tags?: Array<{ name: string; value: string }>;
  };
}

export interface VerifyResult {
  ok: boolean;
  event?: ResendWebhookEvent;
  errorMessage?: string;
}

/**
 * Verify svix signature on a Resend webhook delivery. Throws nothing — returns
 * a result object. Caller returns HTTP 401 on failure.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string },
): VerifyResult {
  if (!config.RESEND_WEBHOOK_SECRET) {
    return { ok: false, errorMessage: 'RESEND_WEBHOOK_SECRET not configured' };
  }
  const { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } = headers;
  if (!id || !ts || !sig) {
    return { ok: false, errorMessage: 'missing svix headers' };
  }
  try {
    const wh = new Webhook(config.RESEND_WEBHOOK_SECRET);
    const event = wh.verify(rawBody, {
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': sig,
    }) as ResendWebhookEvent;
    return { ok: true, event };
  } catch (e) {
    return { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Apply a verified Resend event to the EmailEvent + EmailSuppression + User tables.
 */
export async function handleResendEvent(event: ResendWebhookEvent): Promise<void> {
  const { type, data } = event;
  const providerMessageId = data.email_id;
  if (!providerMessageId) return;

  const existing = await prisma.emailEvent.findFirst({
    where: { providerMessageId },
  });
  if (!existing) {
    logger.warn({ providerMessageId, type }, 'webhook for unknown providerMessageId');
    return;
  }

  const now = new Date();
  switch (type) {
    case 'email.sent':
      if (existing.status === 'queued') {
        await prisma.emailEvent.update({
          where: { id: existing.id },
          data: { status: 'sent', sentAt: existing.sentAt ?? now },
        });
      }
      break;
    case 'email.delivered':
      await prisma.emailEvent.update({
        where: { id: existing.id },
        data: { status: 'delivered', deliveredAt: now },
      });
      break;
    case 'email.bounced': {
      const bounceType = data.bounce?.type ?? 'unknown';
      await prisma.emailEvent.update({
        where: { id: existing.id },
        data: {
          status: 'bounced',
          errorCode: 'ERR_EMAIL_BOUNCED',
          errorMessage: `${bounceType}: ${data.bounce?.message ?? ''}`.slice(0, 500),
        },
      });
      // Hard bounces → suppression. Soft bounces are retried by Resend; don't suppress.
      if (
        bounceType.toLowerCase().includes('permanent') ||
        bounceType.toLowerCase().includes('hard')
      ) {
        await prisma.emailSuppression.upsert({
          where: { email: existing.toEmail },
          create: {
            email: existing.toEmail,
            reason: 'hard_bounce',
            userId: existing.userId,
            notes: data.bounce?.message ?? undefined,
          },
          update: { reason: 'hard_bounce' },
        });
      }
      break;
    }
    case 'email.complained': {
      await prisma.emailEvent.update({
        where: { id: existing.id },
        data: {
          status: 'complained',
          errorCode: 'ERR_EMAIL_COMPLAINED',
          errorMessage: 'recipient marked as spam',
        },
      });
      await prisma.emailSuppression.upsert({
        where: { email: existing.toEmail },
        create: {
          email: existing.toEmail,
          reason: 'complaint',
          userId: existing.userId,
        },
        update: { reason: 'complaint' },
      });
      // Flip global kill switch for that user — spam complaint is a loud opt-out signal.
      if (existing.userId) {
        await prisma.user.update({
          where: { id: existing.userId },
          data: {
            emailDoNotEmail: true,
            notifyLimitAlerts: false,
            notifyReleases: false,
            notifyBilling: false,
            emailDigestEnabled: false,
          },
        });
      }
      break;
    }
    case 'email.delivery_delayed':
      logger.info({ providerMessageId }, 'Resend delivery delayed');
      break;
    case 'email.opened':
    case 'email.clicked':
      // Analytics only — skip for MVP
      break;
    default:
      logger.info({ type }, 'Unhandled Resend event type');
  }
}

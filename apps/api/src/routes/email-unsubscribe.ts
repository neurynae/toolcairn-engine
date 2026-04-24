// One-click unsubscribe endpoint. Consumes a single-use MagicLinkToken
// (kind='unsubscribe') and flips the matching User.notify* flag based on
// the token's payload.emailKind hint (or falls back to emailDoNotEmail=true).
//
// Proxied by the public web app at /api/email/unsubscribe.
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:email-unsubscribe' });

const KIND_TO_USER_FIELD: Record<string, keyof UpdateFields> = {
  threshold_90: 'notifyLimitAlerts',
  threshold_100: 'notifyLimitAlerts',
  pro_activated: 'notifyBilling',
  pro_expiring_soon: 'notifyBilling',
  pro_expired: 'notifyBilling',
  mcp_release: 'notifyReleases',
  deprecation_notice: 'notifyReleases',
  weekly_digest: 'emailDigestEnabled',
};

interface UpdateFields {
  notifyLimitAlerts?: boolean;
  notifyReleases?: boolean;
  notifyBilling?: boolean;
  emailDigestEnabled?: boolean;
  emailDoNotEmail?: boolean;
}

const bodySchema = z.object({ token: z.string().min(10) });

export function emailUnsubscribeRoutes(): Hono {
  const app = new Hono();

  app.post('/unsubscribe', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_token' }, 400);
    const { token } = parsed.data;

    const record = await prisma.magicLinkToken.findUnique({ where: { token } });
    if (!record || record.kind !== 'unsubscribe') {
      return c.json({ ok: false, error: 'invalid_token' }, 400);
    }
    if (record.usedAt) return c.json({ ok: false, error: 'token_already_used' }, 409);
    if (record.expiresAt < new Date()) return c.json({ ok: false, error: 'token_expired' }, 410);

    const emailKind = (record.payload as Record<string, unknown> | null)?.emailKind as
      | string
      | undefined;
    const targetField = emailKind && KIND_TO_USER_FIELD[emailKind];

    const update: UpdateFields = targetField ? { [targetField]: false } : { emailDoNotEmail: true };

    await prisma.$transaction(async (tx) => {
      await tx.magicLinkToken.update({ where: { token }, data: { usedAt: new Date() } });
      if (record.userId) {
        await tx.user.update({ where: { id: record.userId }, data: update });
      }
    });
    logger.info({ userId: record.userId, field: targetField ?? 'all' }, 'user unsubscribed');
    return c.json({ ok: true, field: targetField ?? 'all' });
  });

  return app;
}

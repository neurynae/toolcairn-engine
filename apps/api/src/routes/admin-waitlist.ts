// Admin waitlist management — list + grant free-month Pro.
// Mounted under /v1/admin/waitlist/*, guarded by adminAuth (Bearer JWT).
//
// Why this lives on the engine side: the admin web runs on Vercel but
// production Postgres is VPS-internal and not reachable from Vercel IPs,
// so the admin dashboard must proxy through the engine API to read/write.
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminAuth } from '../middleware/admin-auth.js';

const logger = createLogger({ name: '@toolcairn/api:admin-waitlist' });

const grantSchema = z.object({ waitlistId: z.string().uuid() });

export function adminWaitlistRoutes(): Hono {
  const app = new Hono();
  app.use('*', adminAuth);

  /** List all waitlist entries — pending first, then granted. */
  app.get('/', async (c) => {
    const rows = await prisma.waitlist.findMany({
      orderBy: [{ granted: 'asc' }, { joinedAt: 'asc' }],
      take: 500,
    });
    return c.json({ ok: true, rows });
  });

  /**
   * Grant a free-month Pro plan to a waitlisted user. Atomically:
   *   1. Flip User.plan → 'pro' + set planExpiresAt = now + 30d.
   *   2. Mark Waitlist row granted.
   *   3. Enqueue pro_activated (immediate), pro_expiring_soon (T-7d),
   *      pro_expired (T+30d, reverts plan).
   */
  app.post('/grant', async (c) => {
    const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'invalid_body' }, 400);
    }
    const { waitlistId } = parsed.data;

    const row = await prisma.waitlist.findUnique({ where: { id: waitlistId } });
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
    if (row.granted) return c.json({ ok: true, alreadyGranted: true });

    const user = await prisma.user.findUnique({ where: { email: row.email } });
    if (!user) {
      await prisma.waitlist.update({
        where: { id: row.id },
        data: {
          granted: true,
          grantedAt: new Date(),
          notes: 'granted but user account not found — contact manually',
        },
      });
      return c.json({ ok: true, userNotFound: true });
    }

    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { plan: 'pro', planExpiresAt: expiresAt },
      });
      await tx.waitlist.update({
        where: { id: row.id },
        data: { granted: true, grantedAt: new Date(), freeMonthExpiresAt: expiresAt },
      });
      await enqueueEmail(tx, {
        kind: EmailKind.ProActivated,
        userId: user.id,
        toEmail: user.email,
        scopeKey: `waitlist_grant:${row.id}`,
        payload: {
          planKey: 'waitlist_free_month',
          expiresAt: expiresAt.toISOString(),
          source: 'waitlist_grant',
        },
      });
      await enqueueEmail(tx, {
        kind: EmailKind.ProExpiringSoon,
        userId: user.id,
        toEmail: user.email,
        scopeKey: `waitlist_grant:${row.id}:t-7`,
        payload: {
          planKey: 'waitlist_free_month',
          expiresAt: expiresAt.toISOString(),
          source: 'waitlist_grant',
        },
        scheduledFor: new Date(expiresAt.getTime() - 7 * 86_400_000),
      });
      await enqueueEmail(tx, {
        kind: EmailKind.ProExpired,
        userId: user.id,
        toEmail: user.email,
        scopeKey: `waitlist_grant:${row.id}:expired`,
        payload: { source: 'waitlist_grant_ended' },
        scheduledFor: expiresAt,
      });
    });

    logger.info({ waitlistId, userId: user.id, expiresAt }, 'admin granted free month');
    return c.json({ ok: true, expiresAt: expiresAt.toISOString() });
  });

  return app;
}

// Admin email tooling — preview + history + re-send.
// Mounted under /v1/admin/emails/*. Reuses the existing adminAuth middleware
// (Bearer JWT issued by /v1/admin/login) so the admin dashboard can proxy here
// with the admin_token cookie like every other admin endpoint.
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import {
  EmailKind,
  type EmailKindValue,
  enqueueEmail,
  renderTemplate,
} from '@toolcairn/notifications';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminAuth } from '../middleware/admin-auth.js';

const logger = createLogger({ name: '@toolcairn/api:admin-emails' });

const previewSchema = z.object({
  kind: z.enum([
    EmailKind.Welcome,
    EmailKind.Threshold90,
    EmailKind.ThresholdExhausted,
    EmailKind.ProActivated,
    EmailKind.ProExpiringSoon,
    EmailKind.ProExpired,
    EmailKind.McpRelease,
    EmailKind.DeprecationNotice,
    EmailKind.WeeklyDigest,
  ]),
  toEmail: z.string().email().default('preview@example.com'),
  name: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const resendSchema = z.object({ emailEventId: z.string().uuid() });

export function adminEmailsRoutes(): Hono {
  const app = new Hono();

  // Admin JWT gate — same middleware as /v1/admin/*
  app.use('*', adminAuth);

  /** Preview any template without sending — fake payload defaults wired per-kind. */
  app.post('/preview', async (c) => {
    const parsed = previewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    const { kind, toEmail, name, payload } = parsed.data;
    const rendered = renderTemplate(kind as EmailKindValue, {
      userId: null,
      toEmail,
      name: name ?? null,
      payload,
      unsubscribeUrl: `${config.PUBLIC_APP_URL}/email/unsubscribe?token=preview`,
      companyAddress: config.COMPANY_ADDRESS,
      publicAppUrl: config.PUBLIC_APP_URL,
    });
    return c.json({ ok: true, ...rendered });
  });

  /** History — last N EmailEvent rows, newest first. Optional filter by userId/email. */
  app.get('/history', async (c) => {
    const userId = c.req.query('userId');
    const email = c.req.query('email');
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10), 500);
    const rows = await prisma.emailEvent.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(email ? { toEmail: email.toLowerCase() } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return c.json({ ok: true, count: rows.length, rows });
  });

  /** Re-send — creates a new EmailOutbox row with a salted scopeKey so the
   *  dedup guard doesn't short-circuit. Logs who triggered the resend. */
  app.post('/resend', async (c) => {
    const parsed = resendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const { emailEventId } = parsed.data;
    const original = await prisma.emailEvent.findUnique({ where: { id: emailEventId } });
    if (!original) return c.json({ error: 'not_found' }, 404);

    // Grab the original outbox payload by emailEvent.outboxId when available;
    // otherwise the admin must supply payload manually via preview.
    if (!original.outboxId) {
      return c.json({ error: 'no_payload', message: 'original outbox row missing' }, 400);
    }
    const outbox = await prisma.emailOutbox.findUnique({ where: { id: original.outboxId } });
    if (!outbox) return c.json({ error: 'no_payload' }, 400);

    const r = await enqueueEmail(prisma, {
      kind: outbox.kind as EmailKindValue,
      userId: outbox.userId,
      toEmail: outbox.toEmail,
      scopeKey: `${outbox.scopeKey}:resend-${Date.now()}`,
      payload: outbox.payload as Record<string, unknown>,
      requestId: c.req.header('x-request-id'),
    });
    logger.warn({ emailEventId, status: r.status }, 'admin triggered email resend');
    return c.json({ ok: true, status: r.status });
  });

  /** DLQ view — rows in email-jobs-dead (for manual inspection). */
  app.get('/dead-letters', async (c) => {
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10), 500);
    const rows = await prisma.emailEvent.findMany({
      where: { status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return c.json({ ok: true, count: rows.length, rows });
  });

  return app;
}

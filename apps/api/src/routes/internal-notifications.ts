// Internal-only routes called by the CF Worker and CI pipelines.
// Mounted under /v1/internal/*; origin-auth already protects all /v1/* except
// the public-paths allow-list, so these are ORIGIN_SECRET-gated.
import { randomBytes } from 'node:crypto';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:internal-notifications' });

const usageEventSchema = z.object({
  userId: z.string().uuid(),
  threshold: z.union([z.literal(90), z.literal(100)]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

const releaseAnnounceSchema = z.object({
  package: z.string(),
  prev: z.string(),
  curr: z.string(),
  kind: z.enum(['minor', 'major']).default('minor'),
  releaseNotesUrl: z.string().url(),
  deprecations: z
    .array(
      z.object({
        feature: z.string(),
        removesInVersion: z.string().optional(),
        migrateTo: z.string().optional(),
      }),
    )
    .optional(),
});

export function internalNotificationsRoutes(): Hono {
  const app = new Hono();

  /**
   * CF-Worker → API callback on daily-limit threshold crossing.
   * Idempotent: EmailEvent UNIQUE on (userId, kind, scopeKey=YYYY-MM-DD) dedups.
   */
  app.post('/usage-event', async (c) => {
    const parsed = usageEventSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const { userId, threshold, date, used, limit } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailDoNotEmail: true, notifyLimitAlerts: true },
    });
    if (!user) return c.json({ ok: true, skipped: 'user_not_found' });

    const isExhausted = threshold === 100;
    const kind = isExhausted ? EmailKind.ThresholdExhausted : EmailKind.Threshold90;

    // For the 100% email we also mint a single-use waitlist-join magic link.
    let waitlistJoinUrl: string | undefined;
    if (isExhausted) {
      const token = randomBytes(24).toString('base64url');
      await prisma.magicLinkToken.create({
        data: {
          token,
          kind: 'waitlist_join',
          userId: user.id,
          email: user.email,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
          payload: { source: 'daily_limit_email', date },
        },
      });
      const base = process.env.PUBLIC_APP_URL ?? 'https://toolcairn.neurynae.com';
      waitlistJoinUrl = `${base}/waitlist/join?token=${token}`;
    }

    const result = await enqueueEmail(prisma, {
      kind,
      userId: user.id,
      toEmail: user.email,
      scopeKey: date,
      payload: isExhausted ? { used, limit, date, waitlistJoinUrl } : { used, limit, date },
    });
    logger.info({ userId, threshold, date, status: result.status }, 'usage-event enqueued');
    return c.json({ ok: true, status: result.status });
  });

  /**
   * MCP publish workflow → API callback on minor/major npm release.
   * Inserts an McpRelease row (UNIQUE on version) then fans out per-user
   * EmailOutbox rows to every eligible user.
   */
  app.post('/release-announce', async (c) => {
    const parsed = releaseAnnounceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const { curr, prev, kind, releaseNotesUrl, deprecations } = parsed.data;

    try {
      await prisma.mcpRelease.create({
        data: {
          version: curr,
          prevVersion: prev,
          kind,
          releaseNotesUrl,
          deprecations: deprecations as unknown as object | undefined,
        },
      });
    } catch (e) {
      // UNIQUE on version — already announced.
      logger.info({ version: curr, err: e }, 'mcp release already recorded, skipping fanout');
      return c.json({ ok: true, deduped: true });
    }

    // Fanout — iterate eligible users in chunks.
    const CHUNK = 500;
    let skip = 0;
    let totalEnqueued = 0;
    while (true) {
      const users = await prisma.user.findMany({
        where: {
          emailDoNotEmail: false,
          notifyReleases: true,
        },
        select: { id: true, email: true },
        skip,
        take: CHUNK,
        orderBy: { createdAt: 'asc' },
      });
      if (users.length === 0) break;
      for (const u of users) {
        try {
          const r = await enqueueEmail(prisma, {
            kind: EmailKind.McpRelease,
            userId: u.id,
            toEmail: u.email,
            scopeKey: curr,
            payload: {
              version: curr,
              prevVersion: prev,
              kind,
              releaseNotesUrl,
              deprecations: deprecations ?? [],
            },
          });
          if (r.status === 'queued') totalEnqueued++;
        } catch (e) {
          logger.warn({ userId: u.id, err: e }, 'mcp-release enqueue failed (non-fatal)');
        }
      }
      skip += users.length;
      if (users.length < CHUNK) break;
    }

    await prisma.mcpRelease.update({
      where: { version: curr },
      data: { fanoutCompletedAt: new Date() },
    });
    logger.info({ version: curr, totalEnqueued }, 'mcp release fanout complete');
    return c.json({ ok: true, totalEnqueued });
  });

  /**
   * Atomic bonus-credit decrement. Called by the CF Worker when a request
   * exceeds the daily cap but the user has credits left in their one-time
   * bonus pool.
   *
   * SQL-level atomicity: UPDATE ... WHERE bonusCreditRemaining > 0 RETURNING
   * the new value. If no row matches (pool exhausted or user missing),
   * the response carries ok:false so the Worker falls through to the
   * limit-exhausted fallback.
   */
  app.post('/consume-bonus-credit', async (c) => {
    const parsed = z
      .object({ userId: z.string().uuid() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'invalid_body' }, 400);
    }
    const { userId } = parsed.data;
    // Prisma doesn't expose RETURNING for updateMany, so we do it in two steps
    // inside a tx to preserve atomicity.
    try {
      const remaining = await prisma.$transaction(async (tx) => {
        const res = await tx.user.updateMany({
          where: { id: userId, bonusCreditRemaining: { gt: 0 } },
          data: { bonusCreditRemaining: { decrement: 1 } },
        });
        if (res.count === 0) return null;
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { bonusCreditRemaining: true },
        });
        return user?.bonusCreditRemaining ?? 0;
      });
      if (remaining === null) {
        return c.json({ ok: false, error: 'exhausted', remaining: 0 });
      }
      return c.json({ ok: true, remaining });
    } catch (e) {
      logger.error({ err: e, userId }, 'consume-bonus-credit failed');
      return c.json({ ok: false, error: 'internal' }, 500);
    }
  });

  return app;
}

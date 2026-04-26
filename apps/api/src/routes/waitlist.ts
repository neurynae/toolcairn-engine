// Public waitlist endpoints.
//
// Two entry points, both hit POST /v1/waitlist/join:
//   1. Magic-link branch: { token } — clicked from the 100%-quota email.
//   2. Self-serve branch:  { email, userId? } — posted from the public
//      /waitlist landing page or the billing page CTA.
//
// The CF Worker bypasses API-key auth for this path; the route itself relies
// on (a) the magic-link single-use guard or (b) per-email UNIQUE + CF-Worker
// per-IP rate limiting for abuse prevention. Both branches idempotent.
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:waitlist' });

const joinSchema = z.union([
  z.object({ token: z.string().min(10) }),
  z.object({
    email: z.string().email().max(254),
    userId: z.string().uuid().optional(),
    source: z.string().max(64).optional(),
  }),
]);

export function waitlistRoutes(): Hono {
  const app = new Hono();

  app.post('/join', async (c) => {
    const parsed = joinSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

    // ── Magic-link branch ────────────────────────────────────────────────
    if ('token' in parsed.data) {
      const { token } = parsed.data;

      const record = await prisma.magicLinkToken.findUnique({ where: { token } });
      if (!record || record.kind !== 'waitlist_join') {
        return c.json({ error: 'invalid_token' }, 400);
      }
      if (record.usedAt) return c.json({ error: 'token_already_used' }, 409);
      if (record.expiresAt < new Date()) return c.json({ error: 'token_expired' }, 410);

      const source =
        ((record.payload as Record<string, unknown> | null)?.source as string | undefined) ??
        'daily_limit_email';

      const alreadyJoined = await prisma.waitlist.findUnique({
        where: { email: record.email },
        select: { id: true },
      });

      await prisma.$transaction(async (tx) => {
        await tx.magicLinkToken.update({
          where: { token },
          data: { usedAt: new Date() },
        });
        await tx.waitlist.upsert({
          where: { email: record.email },
          create: { email: record.email, userId: record.userId, source },
          update: {},
        });
        // Thank-you confirmation email — only on fresh joins so re-clicking
        // a bookmarked link doesn't spam.
        if (!alreadyJoined && record.userId) {
          const user = await tx.user.findUnique({
            where: { id: record.userId },
            select: { name: true },
          });
          await enqueueEmail(tx, {
            kind: EmailKind.WaitlistJoined,
            userId: record.userId,
            toEmail: record.email,
            scopeKey: '',
            payload: { name: user?.name ?? null, source },
          });
        }
      });

      logger.info({ email: record.email, userId: record.userId }, 'waitlist join (magic link)');
      return c.json({ ok: true, via: 'magic_link' });
    }

    // ── Self-serve branch (billing page / /waitlist landing) ────────────
    const email = parsed.data.email.trim().toLowerCase();
    const source = parsed.data.source ?? 'self_serve';
    const userId = parsed.data.userId ?? null;

    const existing = await prisma.waitlist.findUnique({ where: { email } });
    if (existing) {
      return c.json({ ok: true, alreadyJoined: true, granted: existing.granted });
    }

    // Optional: if userId supplied, verify it belongs to the claimed email so
    // a logged-in user can't join someone else's account to the waitlist.
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (user && user.email.trim().toLowerCase() !== email) {
        return c.json({ error: 'email_mismatch' }, 400);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.waitlist.create({ data: { email, userId, source } });
      // Thank-you confirmation email. Only enqueue when we have a userId so
      // the email/unsubscribe token path still works. Anonymous self-serve
      // joins (no userId) get a silent accept — their signup flow will
      // cover the onboarding emails later.
      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        await enqueueEmail(tx, {
          kind: EmailKind.WaitlistJoined,
          userId,
          toEmail: email,
          scopeKey: '',
          payload: { name: user?.name ?? null, source },
        });
      }
    });

    logger.info({ email, userId, source }, 'waitlist join (self-serve)');
    return c.json({ ok: true, via: 'self_serve' });
  });

  // GET /v1/waitlist/stats — public count for "X+ developers joined" social
  // proof on the billing pre-register block. Returns total joined count + a
  // capped "free passes left" calculation (hard cap of 2000 — adjust the
  // constant below when the early-access window expands).
  app.get('/stats', async (c) => {
    try {
      const FREE_PASS_CAP = 2000;
      const total = await prisma.waitlist.count();
      const free_passes_left = Math.max(0, FREE_PASS_CAP - total);
      return c.json(
        {
          ok: true,
          data: { total_joined: total, free_passes_left, cap: FREE_PASS_CAP },
        },
        200,
        { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=900' },
      );
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  return app;
}

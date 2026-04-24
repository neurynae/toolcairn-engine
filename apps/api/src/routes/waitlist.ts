// Public waitlist endpoints — magic-link redemption.
// No origin-auth exemption here (still /v1/* protected) because the public web
// app fronts the redemption flow and proxies through its own API route with
// the x-origin-secret header. The magic-link token itself is the real auth.
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:waitlist' });

const joinSchema = z.object({ token: z.string().min(10) });

export function waitlistRoutes(): Hono {
  const app = new Hono();

  app.post('/join', async (c) => {
    const parsed = joinSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_token' }, 400);
    const { token } = parsed.data;

    const record = await prisma.magicLinkToken.findUnique({ where: { token } });
    if (!record || record.kind !== 'waitlist_join') {
      return c.json({ error: 'invalid_token' }, 400);
    }
    if (record.usedAt) return c.json({ error: 'token_already_used' }, 409);
    if (record.expiresAt < new Date()) return c.json({ error: 'token_expired' }, 410);

    await prisma.$transaction(async (tx) => {
      await tx.magicLinkToken.update({
        where: { token },
        data: { usedAt: new Date() },
      });
      await tx.waitlist.upsert({
        where: { email: record.email },
        create: {
          email: record.email,
          userId: record.userId,
          source:
            ((record.payload as Record<string, unknown> | null)?.source as string | undefined) ??
            'daily_limit_email',
        },
        update: {}, // first-win semantics — repeat joins are no-ops
      });
    });

    logger.info({ email: record.email, userId: record.userId }, 'waitlist join accepted');
    return c.json({ ok: true });
  });

  return app;
}

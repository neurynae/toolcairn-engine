/**
 * Pro plan gate — checks that a user has an active Pro subscription.
 *
 * Usage in a Hono route:
 *   const proError = await requirePro(userId, prisma);
 *   if (proError) return proError;
 */

import type { PrismaClient } from '@toolcairn/db';
import type { Context } from 'hono';

export async function requirePro(
  userId: string,
  prisma: PrismaClient,
  c: Context,
): Promise<Response | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, planExpiresAt: true },
  });

  if (!user) {
    return c.json({ ok: false, error: 'user_not_found' }, 404);
  }

  const isPro = user.plan === 'pro' && user.planExpiresAt && user.planExpiresAt > new Date();

  if (!isPro) {
    return c.json(
      {
        ok: false,
        error: 'pro_required',
        message:
          'This feature requires a Pro plan. Upgrade at https://toolcairn.neurynae.com/billing',
      },
      403,
    );
  }

  return null; // access granted
}

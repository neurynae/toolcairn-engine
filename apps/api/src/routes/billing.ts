/**
 * Billing endpoints — /v1/billing/*
 *
 * Razorpay subscription management. All plan state is stored in the User model.
 * The Razorpay webhook updates plan on subscription events.
 *
 * Routes:
 *   POST /v1/billing/create-subscription  — create/resume a Razorpay subscription
 *   GET  /v1/billing/status               — current plan, expiry, daily usage
 *   POST /v1/billing/webhook              — Razorpay webhook (NO origin-auth)
 */

import crypto from 'node:crypto';
import { config } from '@toolcairn/config';
import type { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:billing' });

/**
 * Derive payment mode from the Razorpay key prefix.
 * 'test'     — rzp_test_* (sandbox, no real charges)
 * 'live'     — rzp_live_* (production, real charges)
 * 'disabled' — no keys configured
 */
export type PaymentMode = 'test' | 'live' | 'disabled';

export function getPaymentMode(): PaymentMode {
  const keyId = config.RAZORPAY_KEY_ID;
  if (!keyId) return 'disabled';
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return 'disabled';
}

const PLAN_MAP: Record<string, string | undefined> = {
  monthly: config.RAZORPAY_PLAN_MONTHLY,
  quarterly: config.RAZORPAY_PLAN_QUARTERLY,
  semiannual: config.RAZORPAY_PLAN_SEMIANNUAL,
};

// Plan billing intervals in months (for planExpiresAt calculation)
const PLAN_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
};

// biome-ignore lint/suspicious/noExplicitAny: Razorpay SDK has no official types
async function getRazorpay(): Promise<any | null> {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return null;
  // Dynamic ESM import — avoids bundling issues and allows server to start without keys
  const { default: Razorpay } = await import('razorpay');
  return new Razorpay({
    key_id: config.RAZORPAY_KEY_ID,
    key_secret: config.RAZORPAY_KEY_SECRET,
  });
}

/** Verify Razorpay webhook signature */
function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const sigBuf = Buffer.from(signature, 'utf8');
    // timingSafeEqual throws if buffers have different lengths — treat as invalid
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
}

const CreateSubscriptionSchema = z.object({
  plan: z.enum(['monthly', 'quarterly', 'semiannual']),
  user_id: z.string().uuid(),
});

export function billingRoutes(prisma: PrismaClient): Hono {
  const app = new Hono();

  // ── GET /v1/billing/plans — fetch plan details from Razorpay ──────────────
  app.get('/plans', async (c) => {
    const razorpay = await getRazorpay();
    if (!razorpay) {
      return c.json({ ok: false, error: 'payments_not_configured' }, 503);
    }

    const planIds = [
      { key: 'monthly', id: config.RAZORPAY_PLAN_MONTHLY },
      { key: 'quarterly', id: config.RAZORPAY_PLAN_QUARTERLY },
      { key: 'semiannual', id: config.RAZORPAY_PLAN_SEMIANNUAL },
    ].filter((p) => p.id);

    try {
      const plans = await Promise.all(
        planIds.map(async ({ key, id }) => {
          const plan = await razorpay.plans.fetch(id);
          return {
            key,
            plan_id: plan.id as string,
            amount: plan.item?.amount as number, // in paise
            currency: plan.item?.currency as string,
            interval: plan.interval as number,
            period: plan.period as string,
            name: plan.item?.name as string,
          };
        }),
      );

      return c.json({ ok: true, data: { plans, payment_mode: getPaymentMode() } }, 200, {
        'Cache-Control': 'public, max-age=3600',
      });
    } catch (e) {
      logger.error({ err: e }, 'fetch plans failed');
      return c.json(
        { ok: false, error: 'razorpay_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // ── POST /v1/billing/create-subscription ──────────────────────────────────
  app.post('/create-subscription', async (c) => {
    const razorpay = await getRazorpay();
    if (!razorpay) {
      return c.json({ ok: false, error: 'payments_not_configured' }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const parsed = CreateSubscriptionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
        400,
      );
    }

    const { plan, user_id } = parsed.data;
    const planId = PLAN_MAP[plan];
    if (!planId) {
      return c.json({ ok: false, error: 'plan_not_configured' }, 503);
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: user_id },
        select: { id: true, email: true, name: true, razorpayCustomerId: true },
      });
      if (!user) return c.json({ ok: false, error: 'user_not_found' }, 404);

      // Create Razorpay customer if not already created
      let customerId = user.razorpayCustomerId;
      if (!customerId) {
        const customer = await razorpay.customers.create({
          name: user.name ?? user.email,
          email: user.email,
          fail_existing: '0',
        });
        customerId = customer.id as string;
        await prisma.user.update({
          where: { id: user_id },
          data: { razorpayCustomerId: customerId },
        });
      }

      // Create subscription
      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        customer_notify: 1,
        total_count: 12, // max billing cycles
        notes: { user_id, plan },
      });

      logger.info(
        { userId: user_id, plan, subscriptionId: subscription.id },
        'subscription created',
      );

      return c.json({
        ok: true,
        data: {
          subscription_id: subscription.id as string,
          short_url: subscription.short_url as string,
          plan,
        },
      });
    } catch (e) {
      logger.error({ err: e }, 'create-subscription failed');
      return c.json(
        { ok: false, error: 'razorpay_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // ── GET /v1/billing/status ─────────────────────────────────────────────────
  app.get('/status', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    try {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      const [user, dailyUsed, waitlistRow] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            email: true,
            plan: true,
            planExpiresAt: true,
            razorpaySubscriptionId: true,
            bonusCreditRemaining: true,
          },
        }),
        prisma.mcpEvent.count({
          where: { user_id: userId, created_at: { gte: todayStart } },
        }),
        // Resolve the user's email first then look up waitlist; doing it
        // in one round-trip via includes requires a reverse relation we
        // didn't model. Two parallel queries is cheaper than adding a FK.
        prisma.user
          .findUnique({ where: { id: userId }, select: { email: true } })
          .then((u) =>
            u
              ? prisma.waitlist.findUnique({
                  where: { email: u.email },
                  select: { granted: true, joinedAt: true, freeMonthExpiresAt: true },
                })
              : null,
          ),
      ]);

      if (!user) return c.json({ ok: false, error: 'user_not_found' }, 404);

      const isActive =
        user.plan !== 'free' && user.planExpiresAt && user.planExpiresAt > new Date();

      return c.json({
        ok: true,
        data: {
          plan: isActive ? user.plan : 'free',
          expires_at: user.planExpiresAt?.toISOString() ?? null,
          is_active: !!isActive,
          subscription_id: user.razorpaySubscriptionId ?? null,
          daily_used: dailyUsed,
          bonus_credit_remaining: user.bonusCreditRemaining,
          waitlist_joined: !!waitlistRow,
          waitlist_granted: !!waitlistRow?.granted,
          payment_mode: getPaymentMode(),
        },
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // ── POST /v1/billing/webhook ───────────────────────────────────────────────
  // NO origin-auth — called directly by Razorpay. Validates webhook signature.
  app.post('/webhook', async (c) => {
    const signature = c.req.header('X-Razorpay-Signature') ?? '';
    const webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.warn('webhook received but RAZORPAY_WEBHOOK_SECRET not configured');
      return c.json({ ok: true }); // Don't reject — might be test mode
    }

    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      logger.warn('webhook signature verification failed');
      return c.json({ ok: false, error: 'invalid_signature' }, 400);
    }

    let event: { event: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const eventType = event.event;
    logger.info({ eventType }, 'razorpay webhook received');

    // Extract subscription entity from payload
    // biome-ignore lint/suspicious/noExplicitAny: Razorpay payload shape varies by event
    const sub = (event.payload as any)?.subscription?.entity as Record<string, unknown> | undefined;
    const userId = (sub?.notes as Record<string, string> | undefined)?.user_id;
    const planKey = (sub?.notes as Record<string, string> | undefined)?.plan;
    const subscriptionId = sub?.id as string | undefined;

    if (!userId) {
      logger.warn({ eventType }, 'webhook missing user_id in notes');
      return c.json({ ok: true }); // Acknowledge — might be admin-created subscription
    }

    try {
      if (eventType === 'subscription.activated' || eventType === 'subscription.charged') {
        const months = PLAN_MONTHS[planKey ?? 'monthly'] ?? 1;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + months);

        await prisma.$transaction(async (tx) => {
          const user = await tx.user.update({
            where: { id: userId },
            data: {
              plan: 'pro',
              planExpiresAt: expiresAt,
              razorpaySubscriptionId: subscriptionId ?? undefined,
            },
            select: { id: true, email: true },
          });
          // Confirmation email — scopeKey = subscriptionId so renewals of the same
          // sub don't re-mail (UNIQUE on EmailEvent(userId,kind,scopeKey)).
          await enqueueEmail(tx, {
            kind: EmailKind.ProActivated,
            userId: user.id,
            toEmail: user.email,
            scopeKey: subscriptionId ?? `activated:${expiresAt.toISOString()}`,
            payload: {
              planKey: planKey ?? 'monthly',
              expiresAt: expiresAt.toISOString(),
              source: 'razorpay_webhook',
            },
          });
          // T-7d renewal reminder
          const remindAt = new Date(expiresAt.getTime() - 7 * 86_400_000);
          if (remindAt > new Date()) {
            await enqueueEmail(tx, {
              kind: EmailKind.ProExpiringSoon,
              userId: user.id,
              toEmail: user.email,
              scopeKey: `${subscriptionId ?? expiresAt.toISOString()}:t-7`,
              payload: {
                planKey: planKey ?? 'monthly',
                expiresAt: expiresAt.toISOString(),
                source: 'razorpay',
              },
              scheduledFor: remindAt,
            });
          }
        });
        logger.info({ userId, planKey, expiresAt }, 'plan activated/charged → pro');
      } else if (
        eventType === 'subscription.cancelled' ||
        eventType === 'subscription.expired' ||
        eventType === 'subscription.completed'
      ) {
        await prisma.$transaction(async (tx) => {
          const user = await tx.user.update({
            where: { id: userId },
            data: { plan: 'free', planExpiresAt: null },
            select: { id: true, email: true },
          });
          await enqueueEmail(tx, {
            kind: EmailKind.ProExpired,
            userId: user.id,
            toEmail: user.email,
            scopeKey: subscriptionId ?? `expired:${Date.now()}`,
            payload: { source: 'razorpay_lapse' },
          });
        });
        logger.info({ userId, eventType }, 'plan reverted → free');
      } else if (eventType === 'payment.failed') {
        logger.warn({ userId, subscriptionId }, 'payment failed');
        // Don't downgrade immediately — give grace period (Razorpay retries)
      }
    } catch (e) {
      logger.error({ err: e, userId, eventType }, 'webhook processing failed');
      return c.json({ ok: false, error: 'processing_failed' }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}

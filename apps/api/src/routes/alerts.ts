/**
 * Deprecation Alert endpoints — /v1/alerts/*
 *
 * Pro users can subscribe to tool deprecation alerts and receive webhook notifications.
 *
 * Routes:
 *   GET    /v1/alerts                    — list user's alert subscriptions
 *   POST   /v1/alerts/subscribe          — subscribe to a tool { tool_name }
 *   DELETE /v1/alerts/subscribe/:toolName — unsubscribe
 *   PATCH  /v1/alerts/config             — update webhook URL
 */

import type { PrismaClient } from '@toolcairn/db';
import { Hono } from 'hono';
import { z } from 'zod';

const SubscribeSchema = z.object({ tool_name: z.string().min(1).max(200) });
const ConfigSchema = z.object({ alertWebhookUrl: z.string().url().nullable().optional() });

export function alertRoutes(prisma: PrismaClient): Hono {
  const app = new Hono();

  // GET /v1/alerts — list subscriptions for the authenticated user
  app.get('/', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    try {
      const [subscriptions, user] = await Promise.all([
        prisma.alertSubscription.findMany({
          where: { user_id: userId },
          orderBy: { created_at: 'desc' },
          select: { id: true, tool_name: true, created_at: true },
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { alertWebhookUrl: true, plan: true, planExpiresAt: true },
        }),
      ]);

      return c.json({
        ok: true,
        data: {
          subscriptions: subscriptions.map((s) => ({
            id: s.id,
            tool_name: s.tool_name,
            subscribed_at: s.created_at.toISOString(),
          })),
          webhook_url: user?.alertWebhookUrl ?? null,
          is_pro:
            user?.plan === 'pro' && user.planExpiresAt && user.planExpiresAt > new Date()
              ? true
              : false,
        },
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // POST /v1/alerts/subscribe — subscribe to deprecation alerts (Pro only)
  app.post('/subscribe', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    // Pro gate — verify active subscription before allowing alert subscriptions
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, planExpiresAt: true },
    });
    const isPro = user?.plan === 'pro' && user.planExpiresAt && user.planExpiresAt > new Date();
    if (!isPro) {
      return c.json(
        {
          ok: false,
          error: 'pro_required',
          message: 'Deprecation alerts require a Pro plan. Upgrade at /billing',
        },
        403,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const parsed = SubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
        400,
      );
    }

    try {
      const sub = await prisma.alertSubscription.upsert({
        where: { user_id_tool_name: { user_id: userId, tool_name: parsed.data.tool_name } },
        update: {},
        create: { user_id: userId, tool_name: parsed.data.tool_name },
      });
      return c.json({ ok: true, data: { id: sub.id, tool_name: sub.tool_name } }, 201);
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // DELETE /v1/alerts/subscribe/:toolName — unsubscribe
  app.delete('/subscribe/:toolName', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const toolName = decodeURIComponent(c.req.param('toolName'));

    try {
      await prisma.alertSubscription.deleteMany({
        where: { user_id: userId, tool_name: toolName },
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // PATCH /v1/alerts/config — update webhook URL (Pro only)
  app.patch('/config', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    // Pro gate
    const userPlan = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, planExpiresAt: true },
    });
    const isPro =
      userPlan?.plan === 'pro' && userPlan.planExpiresAt && userPlan.planExpiresAt > new Date();
    if (!isPro) {
      return c.json(
        {
          ok: false,
          error: 'pro_required',
          message: 'Webhook alerts require a Pro plan. Upgrade at /billing',
        },
        403,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const parsed = ConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
        400,
      );
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: { alertWebhookUrl: parsed.data.alertWebhookUrl ?? null },
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  return app;
}

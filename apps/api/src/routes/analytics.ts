/**
 * Analytics endpoints — GET /v1/analytics/*
 *
 * Reads from UsageAggregate (materialized by the usage-aggregator job).
 * Powers the public leaderboard and admin metrics dashboard.
 */

import { prisma } from '@toolcairn/db';
import { Hono } from 'hono';
import { z } from 'zod';

const LeaderboardSchema = z.object({
  period: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

function getWindowStart(period: 'daily' | 'weekly' | 'monthly'): Date {
  const now = new Date();
  if (period === 'daily') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (period === 'weekly') {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - 7);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  // monthly
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() - 30);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function analyticsRoutes() {
  const app = new Hono();

  // GET /v1/analytics/leaderboard?period=daily|weekly|monthly&limit=10
  app.get('/leaderboard', async (c) => {
    try {
      const parsed = LeaderboardSchema.safeParse({
        period: c.req.query('period'),
        limit: c.req.query('limit'),
      });
      if (!parsed.success) {
        return c.json(
          { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { period, limit } = parsed.data;
      const since = getWindowStart(period);

      // Aggregate call_count across daily rows in the window
      const rows = await prisma.usageAggregate.groupBy({
        by: ['tool_name'],
        where: { period: 'daily', period_start: { gte: since } },
        _sum: { call_count: true },
        _avg: { avg_duration_ms: true },
        orderBy: { _sum: { call_count: 'desc' } },
        take: limit,
      });

      const entries = rows.map((r, idx) => ({
        rank: idx + 1,
        tool_name: r.tool_name,
        call_count: r._sum.call_count ?? 0,
        avg_duration_ms: Math.round(r._avg.avg_duration_ms ?? 0),
      }));

      return c.json({ ok: true, data: { period, since: since.toISOString(), entries } }, 200, {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/analytics/trending — tools with highest week-over-week growth
  app.get('/trending', async (c) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));
      const now = new Date();

      const thisWeekStart = new Date(now);
      thisWeekStart.setUTCDate(now.getUTCDate() - 7);
      const lastWeekStart = new Date(now);
      lastWeekStart.setUTCDate(now.getUTCDate() - 14);

      const [thisWeek, lastWeek] = await Promise.all([
        prisma.usageAggregate.groupBy({
          by: ['tool_name'],
          where: { period: 'daily', period_start: { gte: thisWeekStart } },
          _sum: { call_count: true },
        }),
        prisma.usageAggregate.groupBy({
          by: ['tool_name'],
          where: {
            period: 'daily',
            period_start: { gte: lastWeekStart, lt: thisWeekStart },
          },
          _sum: { call_count: true },
        }),
      ]);

      const lastWeekMap = new Map(lastWeek.map((r) => [r.tool_name, r._sum.call_count ?? 0]));

      const trending = thisWeek
        .map((r) => {
          const current = r._sum.call_count ?? 0;
          const previous = lastWeekMap.get(r.tool_name) ?? 0;
          const delta = current - previous;
          const pct = previous > 0 ? Math.round((delta / previous) * 100) : 100;
          return { tool_name: r.tool_name, current, previous, delta, growth_pct: pct };
        })
        .filter((r) => r.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, limit)
        .map((r, idx) => ({ rank: idx + 1, ...r }));

      return c.json({ ok: true, data: { entries: trending } }, 200, {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/analytics/tool/:name/stats — per-tool usage history (last 30 days)
  app.get('/tool/:name/stats', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 30);

      const rows = await prisma.usageAggregate.findMany({
        where: { tool_name: name, period: 'daily', period_start: { gte: since } },
        orderBy: { period_start: 'asc' },
        select: { period_start: true, call_count: true, error_count: true, avg_duration_ms: true },
      });

      return c.json({ ok: true, data: { tool_name: name, days: rows } });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  return app;
}

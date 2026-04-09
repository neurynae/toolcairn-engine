/**
 * Analytics endpoints — GET /v1/analytics/*
 *
 * Reads from UsageAggregate (materialized by the usage-aggregator job).
 * Powers the public leaderboard and admin metrics dashboard.
 */

import { computeQualityBreakdown } from '@toolcairn/core';
import { prisma } from '@toolcairn/db';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { Hono } from 'hono';
import { z } from 'zod';

const repo = new MemgraphToolRepository();

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
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() - 30);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Enrich raw usage rows with display_name + quality_score from Memgraph. */
async function enrichWithToolData(
  rows: Array<{ tool_name: string; call_count: number; avg_duration_ms?: number }>,
) {
  // Batch fetch from Memgraph — one query per tool (small N, acceptable)
  const enriched = await Promise.all(
    rows.map(async (r, idx) => {
      try {
        const result = await repo.findByName(r.tool_name);
        const tool = result.ok ? result.data : null;
        return {
          rank: idx + 1,
          tool_name: r.tool_name,
          display_name: tool?.display_name ?? r.tool_name,
          call_count: r.call_count,
          avg_duration_ms: Math.round(r.avg_duration_ms ?? 0),
          quality_score: tool ? computeQualityBreakdown(tool.health).overall : null,
          github_url: tool?.github_url ?? null,
        };
      } catch {
        return {
          rank: idx + 1,
          tool_name: r.tool_name,
          display_name: r.tool_name,
          call_count: r.call_count,
          avg_duration_ms: Math.round(r.avg_duration_ms ?? 0),
          quality_score: null,
          github_url: null,
        };
      }
    }),
  );
  return enriched;
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

      const raw = rows.map((r) => ({
        tool_name: r.tool_name,
        call_count: r._sum.call_count ?? 0,
        avg_duration_ms: r._avg.avg_duration_ms ?? 0,
      }));

      const entries = await enrichWithToolData(raw);

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

      const trendingRaw = thisWeek
        .map((r) => {
          const current = r._sum.call_count ?? 0;
          const previous = lastWeekMap.get(r.tool_name) ?? 0;
          const delta = current - previous;
          const pct = previous > 0 ? Math.round((delta / previous) * 100) : 100;
          return { tool_name: r.tool_name, call_count: current, delta, growth_pct: pct };
        })
        .filter((r) => r.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, limit);

      const enriched = await enrichWithToolData(trendingRaw);
      const trending = enriched.map((e, idx) => ({
        ...e,
        delta: trendingRaw[idx]?.delta ?? 0,
        growth_pct: trendingRaw[idx]?.growth_pct ?? 0,
      }));

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

  // GET /v1/analytics/top-quality?limit=10 — top tools by quality score (from Memgraph)
  // Independent of usage data — always has results.
  app.get('/top-quality', async (c) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));

      // Fetch top tools by maintenance_score from Memgraph
      const result = await repo.findByCategories([
        'vector-database',
        'llm-framework',
        'agent-framework',
        'web-framework',
        'auth',
        'testing',
        'devops',
        'mcp-server',
        'queue',
        'cache',
        'search',
        'embedding',
        'monitoring',
        'relational-database',
        'graph-database',
        'other',
      ]);

      if (!result.ok) {
        return c.json({ ok: true, data: { entries: [] } });
      }

      const entries = result.data
        .map((t) => {
          const qs = computeQualityBreakdown(t.health);
          return {
            tool_name: t.name,
            display_name: t.display_name,
            quality_score: qs.overall,
            maintenance_score: Math.round(t.health.maintenance_score * 100),
            stars: t.health.stars,
            github_url: t.github_url,
          };
        })
        .sort((a, b) => b.quality_score - a.quality_score)
        .slice(0, limit)
        .map((e, idx) => ({ rank: idx + 1, ...e }));

      return c.json({ ok: true, data: { entries } }, 200, {
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

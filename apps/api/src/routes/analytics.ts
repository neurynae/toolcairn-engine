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

  // GET /v1/analytics/top-popular?limit=10 — top tools by absolute GitHub stars.
  // Independent of usage aggregator — sources from Memgraph so the leaderboard
  // always has data even when the event logger has only recorded MCP tool
  // invocations.
  app.get('/top-popular', async (c) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));
      // findTopByStars pushes sort + LIMIT into Memgraph — findAll was timing
      // out across 24k+ nodes and returning empty.
      const result = await repo.findTopByStars(limit);
      if (!result.ok) return c.json({ ok: true, data: { entries: [] } });

      const entries = result.data.map((t, idx) => ({
        rank: idx + 1,
        tool_name: t.name,
        display_name: t.display_name,
        category: t.category,
        stars: t.health.stars ?? 0,
        stars_velocity_90d: t.health.stars_velocity_90d ?? 0,
        quality_score: computeQualityBreakdown(t.health).overall,
        github_url: t.github_url,
      }));

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

  // GET /v1/analytics/top-trending?limit=10 — top tools by 90-day stars velocity.
  // Uses GitHub star-acquisition rate as the trending signal — a real proxy for
  // momentum, independent of whether MCP agents have searched for them.
  app.get('/top-trending', async (c) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));
      const result = await repo.findTopByStarsVelocity(limit);
      if (!result.ok) return c.json({ ok: true, data: { entries: [] } });

      const entries = result.data.map((t, idx) => {
        const velocity = t.health.stars_velocity_90d ?? 0;
        const stars = t.health.stars ?? 0;
        // "% of current stars that were gained in the last 90 days".
        // Previous formula `velocity / (stars - velocity) * 100` was the
        // growth-over-baseline ratio but exploded when velocity ≈ stars
        // (hot new tools). Clamp at 100 so first-index estimates and
        // explosive tools both render sensibly.
        const growth_pct = stars > 0 ? Math.min(100, Math.round((velocity / stars) * 100)) : 0;
        return {
          rank: idx + 1,
          tool_name: t.name,
          display_name: t.display_name,
          category: t.category,
          stars,
          stars_velocity_90d: velocity,
          growth_pct,
          github_url: t.github_url,
        };
      });

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

  // GET /v1/analytics/popular-searches?limit=10&days=30 — most-frequent search
  // queries from the SearchSession table over the lookback window. Powers the
  // "Popular searches" widget on /explore.
  app.get('/popular-searches', async (c) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));
      const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30)));
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days);

      const rows = await prisma.searchSession.groupBy({
        by: ['query'],
        where: { created_at: { gte: since }, query: { not: '' } },
        _count: { query: true },
        orderBy: { _count: { query: 'desc' } },
        take: limit,
      });

      const entries = rows.map((r, idx) => ({
        rank: idx + 1,
        query: r.query.slice(0, 120),
        hits: r._count.query,
      }));

      return c.json({ ok: true, data: { entries, days } }, 200, {
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
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

  // GET /v1/analytics/leaderboard-kpis — aggregate KPI counts for the
  // leaderboard header cards: total tools indexed (Postgres), total search
  // queries executed, and average quality score across top tools.
  app.get('/leaderboard-kpis', async (c) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);

      const [
        toolCount,
        toolsThisWeek,
        toolsLastWeek,
        queryCount,
        queriesThisWeek,
        queriesLastWeek,
        topTools,
      ] = await Promise.all([
        prisma.indexedTool.count(),
        prisma.indexedTool.count({ where: { last_indexed_at: { gte: sevenDaysAgo } } }),
        prisma.indexedTool.count({
          where: { last_indexed_at: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
        }),
        prisma.searchSession.count(),
        prisma.searchSession.count({ where: { created_at: { gte: sevenDaysAgo } } }),
        prisma.searchSession.count({
          where: { created_at: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
        }),
        repo.findTopByStars(100),
      ]);

      let qualityAvg = 0;
      if (topTools.ok && topTools.data.length > 0) {
        const scores = topTools.data.map((t) => computeQualityBreakdown(t.health).overall);
        qualityAvg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
      }

      // Week-over-week delta percent. Falls back to 0 when previous-week
      // baseline is empty (avoids divide-by-zero / Infinity).
      const pct = (curr: number, prev: number): number =>
        prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : 0;

      return c.json(
        {
          ok: true,
          data: {
            tools_indexed: toolCount,
            tools_indexed_delta_pct: pct(toolsThisWeek, toolsLastWeek),
            total_queries: queryCount,
            total_queries_delta_pct: pct(queriesThisWeek, queriesLastWeek),
            quality_avg: qualityAvg,
            quality_avg_delta_pct: 0, // quality is a long-trend metric; delta computed elsewhere
          },
        },
        200,
        { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200' },
      );
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/analytics/category-distribution — counts per category from the
  // Memgraph graph, powering the donut/pie chart in the leaderboard sidebar.
  app.get('/category-distribution', async (c) => {
    try {
      // Use findByCategories with the full known category list — findAll() takes
      // no arguments and can be slow across 28k+ nodes. This covers every category
      // currently in the schema and is fast enough for a sidebar widget.
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
        'developer-tools',
        'productivity',
        'ai',
        'ml',
        'mlops',
      ]);
      if (!result.ok) return c.json({ ok: true, data: { categories: [] } });

      const countMap = new Map<string, number>();
      for (const t of result.data) {
        const cat = t.category ?? 'other';
        countMap.set(cat, (countMap.get(cat) ?? 0) + 1);
      }

      // Collapse long-tail into "Other" — keep top 6 by count
      const sorted = [...countMap.entries()].sort((a, b) => b[1] - a[1]);
      const top6 = sorted.slice(0, 6);
      const otherCount = sorted.slice(6).reduce((s, [, n]) => s + n, 0);
      const categories = [
        ...top6.map(([category, count]) => ({ category, count })),
        ...(otherCount > 0 ? [{ category: 'other', count: otherCount }] : []),
      ];

      return c.json({ ok: true, data: { categories } }, 200, {
        'Cache-Control': 'public, max-age=7200, stale-while-revalidate=14400',
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/analytics/trending-this-week — top 5 tools by 7-day star-velocity
  // delta relative to their total stars. Powers "Trending this week" sidebar.
  app.get('/trending-this-week', async (c) => {
    try {
      const result = await repo.findTopByStarsVelocity(5);
      if (!result.ok) return c.json({ ok: true, data: { entries: [] } });

      const entries = result.data.map((t, idx) => {
        const velocity = t.health.stars_velocity_90d ?? 0;
        const stars = t.health.stars ?? 0;
        // 7-day approximation: velocity is 90-day; divide by ~13 to get weekly
        const weeklyVelocity = Math.round(velocity / 13);
        const growth_pct =
          stars > 0 ? Math.min(999, Math.round((weeklyVelocity / stars) * 100)) : 0;
        return {
          rank: idx + 1,
          tool_name: t.name,
          display_name: t.display_name,
          growth_pct,
          github_url: t.github_url,
        };
      });

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

  return app;
}

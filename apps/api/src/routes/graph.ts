import { MemgraphToolRepository } from '@toolcairn/graph';
import { checkCompatibilitySchema, compareToolsSchema, getStackSchema } from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

const repo = new MemgraphToolRepository();

export function graphRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/graph/compatibility
  app.post('/compatibility', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(checkCompatibilitySchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleCheckCompatibility(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/graph/compare
  app.post('/compare', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(compareToolsSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleCompareTools(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/graph/stack
  app.post('/stack', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(getStackSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleGetStack(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // GET /v1/graph/related-comparisons?tool=<name>&limit=N — sibling tools in
  // the same category, used for the "Related comparisons" panel on /compare.
  // Falls back to the global most-popular list when the requested tool isn't
  // indexed, so the panel always renders something useful.
  app.get('/related-comparisons', async (c) => {
    try {
      const tool = c.req.query('tool')?.trim() ?? '';
      const limit = Math.min(10, Math.max(1, Number(c.req.query('limit') ?? 5)));

      let category: string | null = null;
      const exclude = new Set<string>();
      if (tool) {
        const own = await repo.findByName(tool);
        if (own.ok && own.data) {
          category = own.data.category;
          exclude.add(own.data.name.toLowerCase());
        }
      }

      let candidates: Array<{ name: string; display_name: string }> = [];
      if (category) {
        const siblings = await repo.findByCategories([category]);
        if (siblings.ok) {
          candidates = siblings.data
            .filter((t) => !exclude.has(t.name.toLowerCase()))
            .sort((a, b) => (b.health.stars ?? 0) - (a.health.stars ?? 0))
            .map((t) => ({ name: t.name, display_name: t.display_name }));
        }
      }
      if (candidates.length === 0) {
        const top = await repo.findTopByStars(limit + (tool ? 1 : 0));
        if (top.ok) {
          candidates = top.data
            .filter((t) => !exclude.has(t.name.toLowerCase()))
            .map((t) => ({ name: t.name, display_name: t.display_name }));
        }
      }

      // Pair the input tool with each candidate. When no input tool, return
      // sequential pairs (siblings) so the UI still has comparison rows.
      const pairs: Array<{
        a: string;
        b: string;
        a_display: string;
        b_display: string;
        score: number;
      }> = [];
      const seedScore = 92;
      const stepSize = 3;
      if (tool && candidates.length > 0) {
        for (const [i, c2] of candidates.slice(0, limit).entries()) {
          pairs.push({
            a: tool,
            b: c2.name,
            a_display: tool,
            b_display: c2.display_name,
            score: Math.max(60, seedScore - i * stepSize),
          });
        }
      } else {
        for (let i = 0; i + 1 < candidates.length && pairs.length < limit; i += 2) {
          const a = candidates[i];
          const b = candidates[i + 1];
          if (!a || !b) break;
          pairs.push({
            a: a.name,
            b: b.name,
            a_display: a.display_name,
            b_display: b.display_name,
            score: Math.max(60, seedScore - pairs.length * stepSize),
          });
        }
      }

      return c.json({ ok: true, data: { entries: pairs } }, 200, {
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/graph/deep-dive?a=<name>&b=<name> — real per-tool deep-dive metrics
  // pulled from the graph. Returns one bucket per category (stars-over-time,
  // commit-frequency, issues-response, releases, package-health) with the same
  // shape for both tools, so the UI can render them side by side.
  app.get('/deep-dive', async (c) => {
    try {
      const a = c.req.query('a')?.trim();
      const b = c.req.query('b')?.trim();
      if (!a || !b) {
        return c.json({ ok: false, error: 'missing_params' }, 400);
      }

      const [resA, resB] = await Promise.all([repo.findByName(a), repo.findByName(b)]);
      if (!resA.ok || !resA.data || !resB.ok || !resB.data) {
        return c.json({ ok: false, error: 'not_indexed' }, 404);
      }
      const tA = resA.data;
      const tB = resB.data;

      const buildSide = (t: typeof tA) => ({
        name: t.name,
        display_name: t.display_name,
        stars_over_time: {
          stars: t.health.stars,
          velocity_7d: t.health.stars_velocity_7d,
          velocity_30d: t.health.stars_velocity_30d,
          velocity_90d: t.health.stars_velocity_90d,
          snapshot_at: t.health.stars_snapshot_at,
        },
        commit_frequency: {
          commit_velocity_30d: t.health.commit_velocity_30d,
          last_commit_date: t.health.last_commit_date,
        },
        issues_response: {
          open_issues: t.health.open_issues,
          closed_issues_30d: t.health.closed_issues_30d,
          pr_response_time_hours: t.health.pr_response_time_hours,
        },
        releases: {
          last_release_date: t.health.last_release_date,
        },
        package_health: {
          maintenance_score: t.health.maintenance_score,
          credibility_score: t.health.credibility_score,
          forks_count: t.health.forks_count,
          contributor_count: t.health.contributor_count,
          contributor_trend: t.health.contributor_trend,
        },
      });

      return c.json(
        {
          ok: true,
          data: {
            tool_a: buildSide(tA),
            tool_b: buildSide(tB),
          },
        },
        200,
        { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=3600' },
      );
    } catch (e) {
      return c.json(
        {
          ok: false,
          error: 'internal_error',
          message: e instanceof Error ? e.message : String(e),
        },
        500,
      );
    }
  });

  // GET /v1/graph/popular-comparisons?limit=N — top N comparison pairs across
  // the graph, grouped by category. For each top category we pick the two
  // most-starred tools and pair them — yielding meaningful same-category pairs
  // like "Vitest vs Jest", "Next.js vs Remix", "Postgres vs Supabase".
  app.get('/popular-comparisons', async (c) => {
    try {
      const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 5)));

      // Pull a generous slice of top tools by stars; we then group by category.
      const top = await repo.findTopByStars(200);
      if (!top.ok) {
        return c.json({ ok: false, error: 'graph_error' }, 500);
      }

      // Bucket by category; preserve insertion order which is descending stars.
      const byCategory = new Map<
        string,
        Array<{ name: string; display_name: string; stars: number }>
      >();
      for (const tool of top.data) {
        const bucket = byCategory.get(tool.category);
        const entry = {
          name: tool.name,
          display_name: tool.display_name,
          stars: tool.health.stars ?? 0,
        };
        if (bucket) bucket.push(entry);
        else byCategory.set(tool.category, [entry]);
      }

      // Build pairs: top 2 in each category, ordered by combined stars (most
      // recognisable comparisons surface first).
      const pairs: Array<{
        a: string;
        b: string;
        a_display: string;
        b_display: string;
        score: number;
      }> = [];
      const candidates: Array<{
        a: { name: string; display_name: string; stars: number };
        b: { name: string; display_name: string; stars: number };
        combined: number;
      }> = [];
      for (const [, bucket] of byCategory) {
        if (bucket.length < 2) continue;
        const a = bucket[0];
        const b = bucket[1];
        if (!a || !b) continue;
        candidates.push({ a, b, combined: a.stars + b.stars });
      }
      candidates.sort((x, y) => y.combined - x.combined);

      const seedScore = 92;
      const stepSize = 3;
      for (const [i, { a, b }] of candidates.slice(0, limit).entries()) {
        pairs.push({
          a: a.name,
          b: b.name,
          a_display: a.display_name,
          b_display: b.display_name,
          score: Math.max(60, seedScore - i * stepSize),
        });
      }

      return c.json({ ok: true, data: { entries: pairs } }, 200, {
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
      });
    } catch (e) {
      return c.json(
        {
          ok: false,
          error: 'internal_error',
          message: e instanceof Error ? e.message : String(e),
        },
        500,
      );
    }
  });

  return app;
}

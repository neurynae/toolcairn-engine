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

  return app;
}

/**
 * Public data endpoints — exposed at /v1/data/*
 * No admin auth required — just originAuth (CF Worker handles x-toolpilot-key).
 *
 * These give the Vercel-hosted public site access to tool catalog data
 * (Memgraph) without requiring a direct database connection.
 */

import type { ToolNode } from '@toolcairn/core';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { Hono } from 'hono';
import { z } from 'zod';

const repo = new MemgraphToolRepository();

// UI category slugs — match what the public app sends
const ALL_CATEGORIES = [
  'vector-database',
  'graph-database',
  'relational-database',
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
  'other',
] as const;

type CategorySlug = (typeof ALL_CATEGORIES)[number];

// Map UI slugs to GitHub topics present on real tools
const CATEGORY_TOPIC_MAP: Record<CategorySlug, string[]> = {
  'vector-database': [
    'vector-database',
    'vector-search',
    'vector-search-engine',
    'embeddings-similarity',
    'similarity-search',
  ],
  'graph-database': ['graph-database', 'graph', 'neo4j', 'knowledge-graph'],
  'relational-database': [
    'database',
    'sql',
    'postgresql',
    'mysql',
    'sqlite',
    'orm',
    'relational-database',
  ],
  'llm-framework': [
    'llm',
    'large-language-model',
    'openai',
    'anthropic',
    'llm-framework',
    'ai',
    'chatgpt',
  ],
  'agent-framework': ['agent', 'agents', 'multi-agent', 'ai-agent', 'rag'],
  'web-framework': ['web-framework', 'http', 'express', 'fastify', 'hono', 'koa', 'nestjs'],
  auth: ['auth', 'authentication', 'authorization', 'oauth', 'jwt', 'identity'],
  testing: ['testing', 'test', 'jest', 'vitest', 'playwright', 'e2e'],
  devops: ['devops', 'ci-cd', 'docker', 'kubernetes', 'automation'],
  'mcp-server': ['mcp', 'mcp-server', 'model-context-protocol'],
  queue: ['queue', 'message-queue', 'redis', 'kafka', 'rabbitmq', 'background-jobs'],
  cache: ['cache', 'caching', 'redis', 'memcached'],
  search: ['search', 'full-text-search', 'elasticsearch', 'typesense', 'meilisearch'],
  embedding: ['embeddings', 'embedding', 'sentence-transformers', 'nomic', 'semantic-search'],
  monitoring: ['monitoring', 'observability', 'logging', 'tracing', 'metrics', 'opentelemetry'],
  other: ['other'],
};

const ListToolsSchema = z.object({
  category: z
    .string()
    .refine((v) => (ALL_CATEGORIES as ReadonlyArray<string>).includes(v), {
      message: 'Invalid category',
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function toolShape(t: ToolNode) {
  return {
    name: t.name,
    display_name: t.display_name,
    description: t.description,
    category: t.category,
    github_url: t.github_url,
    maintenance_score: t.health.maintenance_score,
    stars: t.health.stars,
    language: t.language,
    license: t.license,
  };
}

export function dataRoutes() {
  const app = new Hono();

  // GET /v1/data/tools — list tools by category (public catalog)
  app.get('/tools', async (c) => {
    try {
      const parsed = ListToolsSchema.safeParse({
        category: c.req.query('category'),
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      });
      if (!parsed.success) {
        return c.json(
          { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { category, limit, offset } = parsed.data;
      let allTools: ToolNode[] = [];

      if (category) {
        const slug = category as CategorySlug;
        // 1. Try exact category match first
        const exactResult = await repo.findByCategory(slug);
        if (exactResult.ok && exactResult.data.length > 0) {
          allTools = exactResult.data;
        } else {
          // 2. Fall back to topic-based search
          const topics = CATEGORY_TOPIC_MAP[slug] ?? [slug];
          const topicsResult = await repo.findByTopics(topics);
          if (topicsResult.ok) allTools = topicsResult.data;
        }
      } else {
        const allResult = await repo.findByCategories(Array.from(ALL_CATEGORIES));
        if (allResult.ok) allTools = allResult.data;
      }

      const sorted = allTools.sort(
        (a, b) => b.health.maintenance_score - a.health.maintenance_score,
      );
      const total = sorted.length;
      const paged = sorted.slice(offset, offset + limit);

      return c.json({ ok: true, data: { tools: paged.map(toolShape), total } });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/data/tools/:name — single tool detail by name
  app.get('/tools/:name', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));
      const result = await repo.findByName(name);
      if (!result.ok || !result.data) {
        return c.json({ ok: false, error: 'not_found', message: `Tool "${name}" not found` }, 404);
      }
      const t = result.data;
      return c.json({
        ok: true,
        data: {
          name: t.name,
          display_name: t.display_name,
          description: t.description,
          category: t.category,
          github_url: t.github_url,
          homepage_url: t.homepage_url,
          language: t.language,
          languages: t.languages,
          license: t.license,
          topics: t.topics,
          health: t.health,
          docs: t.docs,
        },
      });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/data/tools/names — all tool names for autocomplete
  app.get('/tools/names', async (c) => {
    try {
      const result = await repo.getAllToolNames();
      if (!result.ok) {
        return c.json({ ok: false, error: 'graph_error', message: result.error.message }, 500);
      }

      const q = c.req.query('q') ?? '';
      let names: string[];
      if (!q) {
        names = result.data.slice(0, 20);
      } else {
        const qLower = q.toLowerCase();
        const normalize = (s: string) => s.toLowerCase().replace(/[\s.\-_]/g, '');
        const qNorm = normalize(q);
        const exactPrefix = result.data.filter((n) => n.toLowerCase().startsWith(qLower));
        const substring = result.data.filter(
          (n) => !n.toLowerCase().startsWith(qLower) && n.toLowerCase().includes(qLower),
        );
        const fuzzy = result.data.filter((n) => {
          const nNorm = normalize(n);
          return (
            !n.toLowerCase().includes(qLower) &&
            (nNorm.startsWith(qNorm) ||
              nNorm.includes(qNorm) ||
              qNorm.startsWith(nNorm.slice(0, Math.max(nNorm.length - 2, 2))))
          );
        });
        names = [...exactPrefix, ...substring, ...fuzzy].slice(0, 10);
      }

      return c.json({ ok: true, data: names }, 200, {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
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

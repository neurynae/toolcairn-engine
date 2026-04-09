/**
 * Public data endpoints — exposed at /v1/data/*
 * No admin auth required — just originAuth (CF Worker handles x-toolpilot-key).
 *
 * These give the Vercel-hosted public site access to tool catalog data
 * (Memgraph) without requiring a direct database connection.
 */

import { type ToolNode, computeQualityBreakdown } from '@toolcairn/core';
import { prisma } from '@toolcairn/db';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { Hono } from 'hono';
import { z } from 'zod';

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

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

const SubmitToolSchema = z.object({
  github_url: z
    .string()
    .min(1)
    .refine((v) => GITHUB_URL_RE.test(v.trim()), {
      message: 'Must be a valid GitHub repository URL',
    }),
  user_id: z.string().uuid(),
  note: z.string().max(500).optional(),
});

function toolShape(t: ToolNode) {
  return {
    name: t.name,
    display_name: t.display_name,
    description: t.description,
    category: t.category,
    github_url: t.github_url,
    maintenance_score: t.health.maintenance_score,
    quality_score: Math.round(t.health.maintenance_score * 100),
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
        const exactResult = await repo.findByCategory(slug);
        if (exactResult.ok && exactResult.data.length > 0) {
          allTools = exactResult.data;
        } else {
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

  // GET /v1/data/tools/names — all tool names for autocomplete
  // IMPORTANT: registered BEFORE /tools/:name so literal path takes priority
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

  // POST /v1/data/tools/submit — community tool submission
  // Creates a StagedNode with source='community' for admin review.
  app.post('/tools/submit', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const parsed = SubmitToolSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
        400,
      );
    }

    const { github_url, user_id, note } = parsed.data;
    const normalizedUrl = github_url.trim().replace(/\/$/, '');

    try {
      // Extract fragment for Memgraph URL lookup (github.com/owner/repo)
      const urlFragment = normalizedUrl.replace('https://', '');

      // Check for duplicate — already in graph, crawler tracking, or submitted
      const [graphResult, existing, alreadyStaged] = await Promise.all([
        repo.findByGitHubUrl(urlFragment),
        prisma.indexedTool.findUnique({ where: { github_url: normalizedUrl } }),
        prisma.stagedNode.findFirst({
          where: {
            node_data: { path: ['github_url'], equals: normalizedUrl },
            graduated: false,
          },
        }),
      ]);

      if ((graphResult.ok && graphResult.data) || existing?.index_status === 'indexed') {
        return c.json(
          {
            ok: false,
            error: 'already_indexed',
            message: 'This tool is already in the ToolCairn index.',
          },
          409,
        );
      }
      if (alreadyStaged) {
        return c.json(
          {
            ok: false,
            error: 'already_submitted',
            message: 'This tool has already been submitted and is awaiting review.',
          },
          409,
        );
      }

      const staged = await prisma.stagedNode.create({
        data: {
          node_type: 'Tool',
          node_data: { github_url: normalizedUrl, note: note ?? null },
          confidence: 0.8,
          source: 'community',
          submitted_by: user_id,
          supporting_queries: [],
        },
      });

      return c.json({ ok: true, data: { id: staged.id, status: 'pending' } }, 201);
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/data/tools/submissions — list user's past submissions
  app.get('/tools/submissions', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    try {
      const submissions = await prisma.stagedNode.findMany({
        where: { submitted_by: userId, node_type: 'Tool' },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          id: true,
          node_data: true,
          graduated: true,
          rejection_reason: true,
          created_at: true,
          reviewed_at: true,
        },
      });

      const result = submissions.map((s) => ({
        id: s.id,
        github_url: (s.node_data as Record<string, unknown>)?.github_url ?? null,
        status: s.graduated ? 'approved' : s.rejection_reason ? 'rejected' : 'pending',
        rejection_reason: s.rejection_reason ?? null,
        submitted_at: s.created_at.toISOString(),
        reviewed_at: s.reviewed_at?.toISOString() ?? null,
      }));

      return c.json({ ok: true, data: { submissions: result } });
    } catch (e) {
      return c.json(
        { ok: false, error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  // GET /v1/data/tools/preferences — user's most-used tools (BEFORE :name wildcard)
  app.get('/tools/preferences', async (c) => {
    const userId = c.req.header('X-ToolCairn-User-Id');
    if (!userId) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 10)));

    try {
      const { Redis } = await import('ioredis');
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
      const redis = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 2000,
        maxRetriesPerRequest: 0,
      });
      await redis.connect();
      const tools: Array<{ tool_name: string; count: number }> = [];
      try {
        const raw = await redis.zrevrangebyscore(
          `user:${userId}:tool_prefs`,
          '+inf',
          '-inf',
          'WITHSCORES',
          'LIMIT',
          0,
          limit,
        );
        for (let i = 0; i < raw.length - 1; i += 2) {
          tools.push({ tool_name: raw[i] as string, count: Number(raw[i + 1]) });
        }
      } finally {
        redis.disconnect();
      }
      return c.json({ ok: true, data: { tools } });
    } catch {
      return c.json({ ok: true, data: { tools: [] } });
    }
  });

  // GET /v1/data/tools/:name — single tool detail by name (AFTER all literal paths)
  app.get('/tools/:name', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));
      const [toolResult, relatedResult, neighborhoodResult] = await Promise.all([
        repo.findByName(name),
        repo.getRelated(name, 1),
        repo.getToolNeighborhood(name),
      ]);

      if (!toolResult.ok || !toolResult.data) {
        return c.json({ ok: false, error: 'not_found', message: `Tool "${name}" not found` }, 404);
      }

      const t = toolResult.data;
      const related = (relatedResult.ok ? relatedResult.data : []).slice(0, 6).map((r) => ({
        name: r.name,
        display_name: r.display_name,
        category: r.category,
        maintenance_score: r.health.maintenance_score,
      }));

      return c.json({
        ok: true,
        data: {
          tool: {
            name: t.name,
            display_name: t.display_name,
            description: t.description,
            category: t.category,
            github_url: t.github_url,
            homepage_url: t.homepage_url,
            language: t.language,
            languages: t.languages,
            license: t.license,
            deployment_models: t.deployment_models,
            package_managers: t.package_managers,
            topics: t.topics,
            health: t.health,
            docs: t.docs,
          },
          related,
          neighborhood: neighborhoodResult.ok ? neighborhoodResult.data : null,
          quality_score: computeQualityBreakdown(t.health),
        },
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

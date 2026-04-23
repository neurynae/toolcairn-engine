/**
 * Admin REST endpoints — exposed at /v1/admin/*
 * Includes: login, health, stats, tools (list + detail), edges, graph, progress,
 * review, metrics, events, sessions, outcomes, indexer, settings, topics.
 *
 * All routes (except POST /login) require a valid admin JWT in
 * Authorization: Bearer <token> header.
 *
 * These endpoints allow the Vercel-hosted web app to access all VPS
 * services (Memgraph, PostgreSQL, Qdrant, Redis) through the API proxy
 * instead of connecting to them directly.
 */

import { timingSafeEqual } from 'node:crypto';
import { config } from '@toolcairn/config';
import { PrismaClient } from '@toolcairn/db';
import {
  GET_EDGE_WEIGHT_SUMMARY,
  GET_GRAPH_TOPOLOGY,
  type TopologyRow,
  getMemgraphSession,
  memgraphHealthCheck,
} from '@toolcairn/graph';
import { enqueueDiscoveryTrigger, enqueueIndexJob, enqueueReindexTrigger } from '@toolcairn/queue';
import { qdrantClient, qdrantHealthCheck } from '@toolcairn/vector';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { adminAuth } from '../middleware/admin-auth.js';
import { adminCronRoutes } from './admin-cron.js';

// ─── Shared Prisma singleton ──────────────────────────────────────────────────

const globalForPrisma = globalThis as unknown as { adminPrisma: PrismaClient | undefined };
const prisma = globalForPrisma.adminPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.adminPrisma = prisma;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && typeof (val as Record<string, unknown>).toNumber === 'function') {
    return (val as { toNumber(): number }).toNumber();
  }
  return Number(val) || 0;
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function err(error: string, status = 500) {
  return { ok: false as const, error, status };
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function adminRoutes() {
  const app = new Hono();

  // ── Auth: POST /v1/admin/login (public — no JWT required) ──────────────────
  app.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ passphrase: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: 'INVALID_INPUT' }, 400);

    const secret = config.ADMIN_SECRET ?? '';
    const provided = Buffer.from(parsed.data.passphrase);
    const expected = Buffer.from(secret);
    const matches = provided.length === expected.length && timingSafeEqual(provided, expected);

    if (!matches) return c.json({ ok: false, error: 'INVALID_PASSPHRASE' }, 401);

    const token = await new SignJWT({ sub: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(new TextEncoder().encode(secret));

    return c.json({ ok: true, data: { token } });
  });

  // All subsequent routes require admin JWT
  app.use('/*', adminAuth);

  // ── GET /v1/admin/health ───────────────────────────────────────────────────
  app.get('/health', async (c) => {
    const [memgraph, qdrant, postgres, redis, stats] = await Promise.allSettled([
      memgraphHealthCheck(),
      checkQdrant(),
      checkPostgres(),
      checkRedis(),
      getStats(),
    ]);

    return c.json({
      ok: true,
      data: {
        memgraph:
          memgraph.status === 'fulfilled'
            ? memgraph.value
            : { ok: false, error: String(memgraph.reason) },
        qdrant:
          qdrant.status === 'fulfilled'
            ? qdrant.value
            : { ok: false, error: String(qdrant.reason) },
        postgres:
          postgres.status === 'fulfilled'
            ? postgres.value
            : { ok: false, error: String(postgres.reason) },
        redis:
          redis.status === 'fulfilled' ? redis.value : { ok: false, error: String(redis.reason) },
        stats: stats.status === 'fulfilled' ? stats.value : null,
      },
    });
  });

  // ── GET /v1/admin/graph ────────────────────────────────────────────────────
  app.get('/graph', async (c) => {
    const category = c.req.query('category') ?? '';
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)));
    const TOPIC_LIMIT = 40;
    const GET_TOOL_TOPIC_EDGES = `
UNWIND $toolIds AS toolId
MATCH (t:Tool {id: toolId})-[e]->(topic)
WHERE topic:UseCase OR topic:Pattern OR topic:Stack
WITH topic.name AS topicId,
     CASE WHEN topic:UseCase THEN 'UseCase'
          WHEN topic:Pattern THEN 'Pattern'
          ELSE 'Stack' END AS topicNodeType,
     collect({toolId: t.id, edgeType: type(e)}) AS edges,
     count(DISTINCT t.id) AS connCount
ORDER BY connCount DESC
LIMIT ${TOPIC_LIMIT}
UNWIND edges AS edge
RETURN edge.toolId AS toolId, topicId, topicNodeType, edge.edgeType AS edgeType
`;
    const session = getMemgraphSession();
    try {
      // Query 1: Tool topology (sequential — Memgraph doesn't support parallel sessions)
      const result = await session.run(GET_GRAPH_TOPOLOGY.text, {
        category,
        nodeLimit: neo4j.int(limit),
      });
      const rows: TopologyRow[] = result.records.map((r) => ({
        sourceId: r.get('sourceId') as string,
        sourceName: r.get('sourceName') as string,
        sourceDisplayName: r.get('sourceDisplayName') as string,
        sourceCategory: r.get('sourceCategory') as string,
        sourceMaintenanceScore: toNum(r.get('sourceMaintenanceScore')),
        sourceStars: toNum(r.get('sourceStars')),
        targetId: r.get('targetId') as string | null,
        edgeType: r.get('edgeType') as string | null,
        baseWeight: r.get('baseWeight') as number | null,
        effectiveWeight: r.get('effectiveWeight') as number | null,
        confidence: r.get('confidence') as number | null,
        edgeSource: r.get('edgeSource') as string | null,
      }));

      // Query 2: Topic edges (UseCase/Pattern/Stack connected to shown tools)
      const toolIds = [...new Set(rows.map((r) => r.sourceId))];
      const topicEdges: Array<{
        toolId: string;
        topicId: string;
        topicNodeType: string;
        edgeType: string;
      }> = [];
      if (toolIds.length > 0) {
        const topicResult = await session.run(GET_TOOL_TOPIC_EDGES, { toolIds });
        for (const rec of topicResult.records) {
          topicEdges.push({
            toolId: rec.get('toolId') as string,
            topicId: rec.get('topicId') as string,
            topicNodeType: rec.get('topicNodeType') as string,
            edgeType: rec.get('edgeType') as string,
          });
        }
      }

      return c.json(ok({ rows, topicEdges }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Graph error'), 500);
    } finally {
      await session.close();
    }
  });

  // ── GET /v1/admin/weights ──────────────────────────────────────────────────
  app.get('/weights', async (c) => {
    const GET_TOOL_HEALTH = `
      MATCH (t:Tool)
      RETURN t.id AS id, t.name AS name, coalesce(t.display_name, t.name) AS displayName,
             t.category AS category,
             t.health_maintenance_score AS maintenanceScore,
             t.health_stars AS stars,
             t.health_stars_velocity_90d AS starsVelocity90d,
             t.health_commit_velocity_30d AS commitVelocity30d,
             t.health_last_commit_date AS lastCommitDate,
             t.health_contributor_count AS contributorCount,
             t.health_open_issues AS openIssues
      ORDER BY t.health_maintenance_score DESC
    `;
    const session = getMemgraphSession();
    try {
      const toolsResult = await session.run(GET_TOOL_HEALTH);
      const edgesResult = await session.run(GET_EDGE_WEIGHT_SUMMARY.text);
      const tools = toolsResult.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        displayName: r.get('displayName') as string,
        category: r.get('category') as string,
        maintenanceScore: toNum(r.get('maintenanceScore')),
        stars: toNum(r.get('stars')),
        starsVelocity90d: toNum(r.get('starsVelocity90d')),
        commitVelocity30d: toNum(r.get('commitVelocity30d')),
        lastCommitDate: (r.get('lastCommitDate') as string | null) ?? '',
        contributorCount: toNum(r.get('contributorCount')),
        openIssues: toNum(r.get('openIssues')),
      }));
      const edgeWeightSummary = edgesResult.records.map((r) => ({
        edgeType: r.get('edgeType') as string,
        avgEffectiveWeight: toNum(r.get('avgEffectiveWeight')),
        edgeCount: toNum(r.get('edgeCount')),
      }));
      return c.json(ok({ tools, edgeWeightSummary }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Weights error'), 500);
    } finally {
      await session.close();
    }
  });

  // ── GET /v1/admin/tools ────────────────────────────────────────────────────
  app.get('/tools', async (c) => {
    const search = c.req.query('search') ?? '';
    const category = c.req.query('category') ?? '';
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 30)));
    const skip = (page - 1) * pageSize;

    const QUERY = `
      MATCH (t:Tool)
      WHERE ($category = '' OR t.category = $category)
        AND ($search = '' OR toLower(t.name) CONTAINS toLower($search)
             OR toLower(coalesce(t.display_name, '')) CONTAINS toLower($search))
      RETURN t.id AS id, t.name AS name, coalesce(t.display_name, t.name) AS displayName,
             t.category AS category, t.language AS language, t.github_url AS githubUrl,
             t.health_maintenance_score AS maintenanceScore, t.health_stars AS stars,
             t.health_stars_velocity_90d AS starsVelocity90d,
             t.health_last_commit_date AS lastCommitDate,
             t.health_contributor_count AS contributorCount
      ORDER BY t.health_maintenance_score DESC
      SKIP $skip LIMIT $limit
    `;
    const COUNT = `
      MATCH (t:Tool)
      WHERE ($category = '' OR t.category = $category)
        AND ($search = '' OR toLower(t.name) CONTAINS toLower($search)
             OR toLower(coalesce(t.display_name, '')) CONTAINS toLower($search))
      RETURN count(t) AS total
    `;
    const session = getMemgraphSession();
    try {
      const countResult = await session.run(COUNT, { search, category });
      const total = toNum(countResult.records[0]?.get('total'));
      const toolsResult = await session.run(QUERY, {
        search,
        category,
        skip: neo4j.int(skip),
        limit: neo4j.int(pageSize),
      });
      const tools = toolsResult.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        displayName: r.get('displayName') as string,
        category: r.get('category') as string,
        language: (r.get('language') as string | null) ?? '',
        githubUrl: (r.get('githubUrl') as string | null) ?? '',
        maintenanceScore: toNum(r.get('maintenanceScore')),
        stars: toNum(r.get('stars')),
        starsVelocity90d: toNum(r.get('starsVelocity90d')),
        lastCommitDate: (r.get('lastCommitDate') as string | null) ?? '',
        contributorCount: toNum(r.get('contributorCount')),
      }));
      return c.json(ok({ tools, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Tools error'), 500);
    } finally {
      await session.close();
    }
  });

  // ── GET /v1/admin/tools/:name ─────────────────────────────────────────────
  app.get('/tools/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const session = getMemgraphSession();
    try {
      const result = await session.run(
        `MATCH (t:Tool { name: $name })
         OPTIONAL MATCH (t)-[e]-(related:Tool)
         WITH t, related, e, type(e) AS edgeType,
              CASE WHEN e.last_verified IS NULL THEN e.weight
                   ELSE e.weight * exp(-e.decay_rate * CASE WHEN e.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e.last_verified)).day END)
              END AS effectiveWeight
         RETURN t, related, edgeType, effectiveWeight, e.confidence AS confidence
         ORDER BY effectiveWeight DESC LIMIT 20`,
        { name },
      );

      if (result.records.length === 0) {
        return c.json({ ok: false, error: 'not_found' }, 404);
      }

      function nodeProps(node: unknown): Record<string, unknown> {
        if (node && typeof node === 'object' && 'properties' in node) {
          return (node as { properties: Record<string, unknown> }).properties;
        }
        return {};
      }

      const p = nodeProps(result.records[0]?.get('t'));
      const tool = {
        id: p.id as string,
        name: p.name as string,
        displayName: (p.display_name as string | null) ?? (p.name as string),
        description: (p.description as string | null) ?? '',
        category: (p.category as string | null) ?? '',
        language: (p.language as string | null) ?? '',
        languages: (p.languages as string[] | null) ?? [],
        githubUrl: (p.github_url as string | null) ?? '',
        homepageUrl: (p.homepage_url as string | null) ?? null,
        license: (p.license as string | null) ?? '',
        deploymentModels: (p.deployment_models as string[] | null) ?? [],
        topics: (p.topics as string[] | null) ?? [],
        health: {
          stars: toNum(p.health_stars),
          starsVelocity90d: toNum(p.health_stars_velocity_90d),
          maintenanceScore: toNum(p.health_maintenance_score),
          lastCommitDate: (p.health_last_commit_date as string | null) ?? '',
          commitVelocity30d: toNum(p.health_commit_velocity_30d),
          openIssues: toNum(p.health_open_issues),
          closedIssues30d: toNum(p.health_closed_issues_30d),
          contributorCount: toNum(p.health_contributor_count),
          prResponseTimeHours: toNum(p.health_pr_response_time_hours),
          lastReleaseDate: (p.health_last_release_date as string | null) ?? '',
        },
        docs: {
          readmeUrl: (p.docs_readme_url as string | null) ?? null,
          docsUrl: (p.docs_docs_url as string | null) ?? null,
          apiUrl: (p.docs_api_url as string | null) ?? null,
          changelogUrl: (p.docs_changelog_url as string | null) ?? null,
        },
      };

      const neighbors = result.records
        .filter((r) => r.get('related') !== null)
        .map((r) => {
          const rp = nodeProps(r.get('related') as unknown);
          return {
            toolName: rp.name as string,
            toolDisplayName: (rp.display_name as string | null) ?? (rp.name as string),
            edgeType: r.get('edgeType') as string,
            effectiveWeight: toNum(r.get('effectiveWeight')),
            confidence: toNum(r.get('confidence')),
          };
        });

      return c.json(ok({ tool, neighbors }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Tool error'), 500);
    } finally {
      await session.close();
    }
  });

  // ── GET /v1/admin/edges ────────────────────────────────────────────────────
  app.get('/edges', async (c) => {
    const edgeType = c.req.query('edgeType') ?? '';
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 30)));
    const skip = (page - 1) * pageSize;

    const QUERY = `
      MATCH (a:Tool)-[e]->(b:Tool)
      WHERE $edgeType = '' OR type(e) = $edgeType
      WITH a, b, e,
           e.weight * exp(-e.decay_rate *
             CASE WHEN e.last_verified IS NULL THEN 0
                  ELSE (datetime() - datetime(e.last_verified)).day END
           ) AS effectiveWeight
      RETURN a.id AS sourceId, a.name AS sourceName, coalesce(a.display_name, a.name) AS sourceDisplayName,
             b.id AS targetId, b.name AS targetName, coalesce(b.display_name, b.name) AS targetDisplayName,
             type(e) AS edgeType, e.weight AS baseWeight, effectiveWeight,
             e.confidence AS confidence, e.source AS edgeSource, e.last_verified AS lastVerified
      ORDER BY effectiveWeight DESC
      SKIP $skip LIMIT $limit
    `;
    const COUNT = `
      MATCH (a:Tool)-[e]->(b:Tool)
      WHERE $edgeType = '' OR type(e) = $edgeType
      RETURN count(e) AS total
    `;
    const TYPES = 'MATCH ()-[e]->() RETURN DISTINCT type(e) AS edgeType ORDER BY edgeType';
    const session = getMemgraphSession();
    try {
      const countResult = await session.run(COUNT, { edgeType });
      const total = toNum(countResult.records[0]?.get('total'));
      const edgesResult = await session.run(QUERY, {
        edgeType,
        skip: neo4j.int(skip),
        limit: neo4j.int(pageSize),
      });
      const typesResult = await session.run(TYPES);
      const edgeTypes = typesResult.records.map((r) => r.get('edgeType') as string);
      const edges = edgesResult.records.map((r) => ({
        sourceId: r.get('sourceId') as string,
        sourceName: r.get('sourceName') as string,
        sourceDisplayName: r.get('sourceDisplayName') as string,
        targetId: r.get('targetId') as string,
        targetName: r.get('targetName') as string,
        targetDisplayName: r.get('targetDisplayName') as string,
        edgeType: r.get('edgeType') as string,
        baseWeight: toNum(r.get('baseWeight')),
        effectiveWeight: toNum(r.get('effectiveWeight')),
        confidence: toNum(r.get('confidence')),
        edgeSource: (r.get('edgeSource') as string | null) ?? '',
        lastVerified: (r.get('lastVerified') as string | null) ?? null,
      }));
      return c.json(
        ok({ edges, total, page, pageSize, totalPages: Math.ceil(total / pageSize), edgeTypes }),
      );
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Edges error'), 500);
    } finally {
      await session.close();
    }
  });

  // ── GET /v1/admin/review/nodes ─────────────────────────────────────────────
  app.get('/review/nodes', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));
    try {
      const [items, total, pendingCount] = await Promise.all([
        prisma.stagedNode.findMany({
          where: { graduated: false },
          orderBy: [{ confidence: 'desc' }, { created_at: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.stagedNode.count(),
        prisma.stagedNode.count({ where: { graduated: false } }),
      ]);
      return c.json(ok({ items, total, pendingCount, page, pageSize }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Review error'), 500);
    }
  });

  // ── PATCH /v1/admin/review/nodes/bulk ─────────────────────────────────────
  // Bulk variant of the single-id approve/reject flow. MUST be registered
  // BEFORE the `/:id` handler below — Hono matches routes in declaration
  // order, so a literal segment has to come first or `:id` swallows the
  // word `bulk` as a node id and returns 404.
  //
  // Accepts:
  //   { ids: string[], action: 'approve' }
  //   { ids: string[], action: 'reject', reason: string }
  //
  // Runs the same per-id logic as the single endpoint (graduated flag,
  // indexer enqueue for Tool approvals) but in one round-trip. Already-
  // graduated / missing rows are reported in the `results` array with
  // ok:false + reason so the client can reconcile — the call itself still
  // returns HTTP 200 unless EVERY item errored.
  app.patch('/review/nodes/bulk', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .discriminatedUnion('action', [
        z.object({
          action: z.literal('approve'),
          ids: z.array(z.string().min(1)).min(1).max(200),
        }),
        z.object({
          action: z.literal('reject'),
          ids: z.array(z.string().min(1)).min(1).max(200),
          reason: z.string().min(1),
        }),
      ])
      .safeParse(body);

    if (!parsed.success) return c.json({ ok: false, error: 'INVALID_INPUT' }, 400);

    try {
      const nodes = await prisma.stagedNode.findMany({
        where: { id: { in: parsed.data.ids } },
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));

      const results: Array<{
        id: string;
        ok: boolean;
        action?: 'approved' | 'rejected';
        indexer_enqueued?: boolean;
        reason?: string;
      }> = [];

      const now = new Date();

      if (parsed.data.action === 'approve') {
        const toUpdateIds: string[] = [];
        const indexerJobs: Array<{ id: string; url: string }> = [];

        for (const id of parsed.data.ids) {
          const node = byId.get(id);
          if (!node) {
            results.push({ id, ok: false, reason: 'NOT_FOUND' });
            continue;
          }
          if (node.graduated) {
            results.push({ id, ok: false, reason: 'ALREADY_REVIEWED' });
            continue;
          }
          toUpdateIds.push(id);

          if (node.node_type === 'Tool') {
            const data = (node.node_data ?? {}) as Record<string, unknown>;
            const rawUrl = typeof data.github_url === 'string' ? data.github_url.trim() : '';
            if (rawUrl) indexerJobs.push({ id, url: rawUrl });
          }
        }

        if (toUpdateIds.length > 0) {
          await prisma.stagedNode.updateMany({
            where: { id: { in: toUpdateIds } },
            data: {
              graduated: true,
              graduated_at: now,
              reviewed_by: 'admin',
              reviewed_at: now,
            },
          });
        }

        const enqueueResults = await Promise.all(
          indexerJobs.map((j) =>
            enqueueIndexJob(j.url, 1)
              .then(() => ({ id: j.id, ok: true }))
              .catch(() => ({ id: j.id, ok: false })),
          ),
        );
        const enqueueOk = new Map(enqueueResults.map((r) => [r.id, r.ok]));

        for (const id of toUpdateIds) {
          const isTool = byId.get(id)?.node_type === 'Tool';
          const hadUrl = indexerJobs.some((j) => j.id === id);
          results.push({
            id,
            ok: true,
            action: 'approved',
            indexer_enqueued: isTool ? (hadUrl ? (enqueueOk.get(id) ?? false) : false) : undefined,
          });
        }
      } else {
        const toUpdateIds: string[] = [];
        for (const id of parsed.data.ids) {
          const node = byId.get(id);
          if (!node) {
            results.push({ id, ok: false, reason: 'NOT_FOUND' });
            continue;
          }
          if (node.graduated) {
            results.push({ id, ok: false, reason: 'ALREADY_REVIEWED' });
            continue;
          }
          toUpdateIds.push(id);
        }

        if (toUpdateIds.length > 0) {
          await prisma.stagedNode.updateMany({
            where: { id: { in: toUpdateIds } },
            data: {
              graduated: true,
              graduated_at: now,
              reviewed_by: 'admin',
              reviewed_at: now,
              rejection_reason: parsed.data.reason,
            },
          });
        }

        for (const id of toUpdateIds) {
          results.push({ id, ok: true, action: 'rejected' });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      return c.json(
        ok({
          action: parsed.data.action,
          requested: parsed.data.ids.length,
          applied: okCount,
          skipped: results.length - okCount,
          results,
        }),
      );
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Bulk review action error'), 500);
    }
  });

  // ── PATCH /v1/admin/review/nodes/:id ──────────────────────────────────────
  // Approval flow by node_type:
  //   Tool     → enqueue an indexer job (priority 1) with the staged github_url.
  //              The indexer runs the full crawl pipeline (registry verify,
  //              health signals, README parse, vector embedding) and only then
  //              upserts to Memgraph. The staged row is marked graduated so
  //              the review queue collapses it.
  //   UseCase  → no indexer path exists; direct-mark graduated. Admin UI will
  //              wire a graph-side upsert in a follow-up.
  //   Other    → direct-mark graduated.
  app.patch('/review/nodes/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('approve') }),
        z.object({ action: z.literal('reject'), reason: z.string().min(1) }),
      ])
      .safeParse(body);

    if (!parsed.success) return c.json({ ok: false, error: 'INVALID_INPUT' }, 400);

    try {
      const node = await prisma.stagedNode.findUnique({ where: { id } });
      if (!node) return c.json({ ok: false, error: 'NOT_FOUND' }, 404);
      if (node.graduated) return c.json({ ok: false, error: 'ALREADY_REVIEWED' }, 409);

      if (parsed.data.action === 'approve') {
        let indexerEnqueued = false;
        let enqueueError: string | null = null;
        let githubUrl: string | null = null;

        if (node.node_type === 'Tool') {
          const data = (node.node_data ?? {}) as Record<string, unknown>;
          const rawUrl = typeof data.github_url === 'string' ? data.github_url.trim() : '';
          if (rawUrl) {
            githubUrl = rawUrl;
            try {
              await enqueueIndexJob(rawUrl, 1);
              indexerEnqueued = true;
            } catch (enqueueErr) {
              enqueueError = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
            }
          } else {
            enqueueError =
              'Tool has no github_url in staged data — cannot enqueue indexer. Reject and re-submit with a valid URL.';
          }
        }

        await prisma.stagedNode.update({
          where: { id },
          data: {
            graduated: true,
            graduated_at: new Date(),
            reviewed_by: 'admin',
            reviewed_at: new Date(),
          },
        });

        return c.json(
          ok({
            id,
            action: 'approved',
            node_type: node.node_type,
            indexer_enqueued: indexerEnqueued,
            indexer_error: enqueueError,
            github_url: githubUrl,
            message:
              node.node_type === 'Tool'
                ? indexerEnqueued
                  ? `Tool staged node ${id} approved. Indexer job enqueued for ${githubUrl}; live-graph ingestion follows crawl completion.`
                  : `Tool staged node ${id} marked approved but indexer enqueue failed: ${enqueueError ?? 'unknown'}. Re-run the indexer trigger manually.`
                : `${node.node_type} staged node ${id} approved (no indexer path for this node type — direct-mark).`,
          }),
        );
      }

      await prisma.stagedNode.update({
        where: { id },
        data: {
          graduated: true,
          graduated_at: new Date(),
          reviewed_by: 'admin',
          reviewed_at: new Date(),
          rejection_reason: parsed.data.reason,
        },
      });
      return c.json(ok({ id, action: 'rejected' }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Review action error'), 500);
    }
  });

  // ── GET /v1/admin/metrics ──────────────────────────────────────────────────
  app.get('/metrics', async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 30)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const [sessionStats, outcomeDistribution, topChosenTools] = await Promise.all([
        prisma.searchSession.groupBy({
          by: ['status'],
          where: { created_at: { gte: since } },
          _count: { id: true },
        }),
        prisma.outcomeReport.groupBy({
          by: ['outcome'],
          where: { created_at: { gte: since }, outcome: { not: null } },
          _count: { id: true },
        }),
        prisma.outcomeReport.groupBy({
          by: ['chosen_tool'],
          where: { created_at: { gte: since } },
          orderBy: { _count: { chosen_tool: 'desc' } },
          take: 10,
          _count: { chosen_tool: true },
        }),
      ]);

      const total = sessionStats.reduce((s, r) => s + r._count.id, 0);
      const completed = sessionStats.find((r) => r.status === 'completed')?._count.id ?? 0;
      const abandoned = sessionStats.find((r) => r.status === 'abandoned')?._count.id ?? 0;

      return c.json(
        ok({
          sessionStats: {
            total,
            completed,
            abandoned,
            completionRate: total > 0 ? completed / total : 0,
          },
          outcomeDistribution: outcomeDistribution.map((r) => ({
            outcome: r.outcome ?? 'unknown',
            count: r._count.id,
          })),
          topChosenTools: topChosenTools.map((r) => ({
            tool: r.chosen_tool,
            count: r._count.chosen_tool,
          })),
          dailySessionVolume: [],
          clarificationEffectiveness: [],
        }),
      );
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Metrics error'), 500);
    }
  });

  // ── GET /v1/admin/events ───────────────────────────────────────────────────
  app.get('/events', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));
    const toolName = c.req.query('toolName');
    const status = c.req.query('status') as 'ok' | 'error' | undefined;

    try {
      const where = {
        ...(toolName && { tool_name: { contains: toolName } }),
        ...(status && { status }),
      };
      const [items, total] = await Promise.all([
        prisma.mcpEvent.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.mcpEvent.count({ where }),
      ]);
      return c.json(ok({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Events error'), 500);
    }
  });

  // ── GET /v1/admin/indexer/status ───────────────────────────────────────────
  app.get('/indexer/status', async (c) => {
    try {
      const [statusCounts, recentlyIndexed, recentFailures, lastIndexed, queueInfo] =
        await Promise.all([
          prisma.indexedTool.groupBy({ by: ['index_status'], _count: { index_status: true } }),
          prisma.indexedTool.findMany({
            where: { index_status: 'indexed', last_indexed_at: { not: null } },
            orderBy: { last_indexed_at: 'desc' },
            take: 10,
            select: { github_url: true, graph_node_id: true, last_indexed_at: true },
          }),
          prisma.indexedTool.findMany({
            where: { index_status: 'failed' },
            orderBy: { updated_at: 'desc' },
            take: 5,
            select: { github_url: true, error_message: true, retry_count: true, updated_at: true },
          }),
          prisma.indexedTool.findFirst({
            where: { index_status: 'indexed', last_indexed_at: { not: null } },
            orderBy: { last_indexed_at: 'desc' },
            select: { last_indexed_at: true },
          }),
          getQueueDepth(),
        ]);

      const counts = { pending: 0, indexed: 0, failed: 0, skipped: 0 };
      for (const row of statusCounts) {
        const key = row.index_status as keyof typeof counts;
        if (key in counts) counts[key] = row._count.index_status;
      }

      return c.json(
        ok({
          counts,
          total: Object.values(counts).reduce((s, v) => s + v, 0),
          lastIndexedAt: lastIndexed?.last_indexed_at?.toISOString() ?? null,
          recentlyIndexed,
          recentFailures,
          queueDepth: queueInfo,
        }),
      );
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Indexer error'), 500);
    }
  });

  // ── GET /v1/admin/indexer/progress ────────────────────────────────────────
  app.get('/indexer/progress', async (c) => {
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 0,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      const raw = await redis.get('toolpilot:indexer:progress');
      return c.json(ok({ progress: raw ? JSON.parse(raw) : null }));
    } catch {
      return c.json(ok({ progress: null }));
    } finally {
      redis.disconnect();
    }
  });

  // ── POST /v1/admin/indexer/discovery ───────────────────────────────────────
  app.post('/indexer/discovery', async (c) => {
    try {
      await enqueueDiscoveryTrigger();
      return c.json(ok({ message: 'Discovery triggered' }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Enqueue error'), 500);
    }
  });

  // ── POST /v1/admin/indexer/reindex ─────────────────────────────────────────
  // Manual trigger — always uses 'manual' to bypass 7-day staleness threshold.
  // Same pattern as TRIGGERED_BY=manual in VPS cron shell scripts.
  app.post('/indexer/reindex', async (c) => {
    try {
      await enqueueReindexTrigger('manual');
      return c.json(ok({ message: 'Reindex triggered' }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Enqueue error'), 500);
    }
  });

  // ── POST /v1/admin/indexer/retry-failed ────────────────────────────────────
  app.post('/indexer/retry-failed', async (c) => {
    try {
      const failedTools = await prisma.indexedTool.findMany({
        where: { index_status: 'failed' },
        select: { github_url: true },
        take: 100,
      });

      let enqueued = 0;
      for (const tool of failedTools) {
        await enqueueIndexJob(tool.github_url, 5);
        enqueued++;
      }

      await prisma.indexedTool.updateMany({
        where: { index_status: 'failed' },
        data: { index_status: 'pending' },
      });

      return c.json(ok({ enqueued, message: `${enqueued} tools re-enqueued` }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Retry error'), 500);
    }
  });

  // ── GET /v1/admin/settings ─────────────────────────────────────────────────
  app.get('/settings', async (c) => {
    try {
      const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
      return c.json(ok(settings));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Settings error'), 500);
    }
  });

  // ── PATCH /v1/admin/settings ───────────────────────────────────────────────
  app.patch('/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        reindex_scheduler_enabled: z.boolean().optional(),
        discovery_scheduler_enabled: z.boolean().optional(),
        discovery_topics: z.array(z.string()).optional(),
        discovery_batch_size: z.number().int().min(1).max(100).optional(),
        discovery_interval_hours: z.number().int().min(1).max(168).optional(),
        discovery_min_stars: z.number().int().min(0).optional(),
        discovery_last_pushed_days: z.number().int().min(1).max(365).optional(),
      })
      .safeParse(body);

    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    try {
      const settings = await prisma.appSettings.upsert({
        where: { id: 'global' },
        create: { id: 'global', ...parsed.data },
        update: parsed.data,
      });
      return c.json(ok(settings));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Settings update error'), 500);
    }
  });

  // ── GET /v1/admin/outcomes ─────────────────────────────────────────────────
  app.get('/outcomes', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));
    try {
      const [items, total] = await Promise.all([
        prisma.outcomeReport.findMany({
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.outcomeReport.count(),
      ]);
      return c.json(ok({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Outcomes error'), 500);
    }
  });

  // ── GET /v1/admin/sessions ─────────────────────────────────────────────────
  app.get('/sessions', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));
    const status = c.req.query('status');
    try {
      const where = status ? { status } : {};
      const [items, total] = await Promise.all([
        prisma.searchSession.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            query: true,
            status: true,
            stage: true,
            created_at: true,
            updated_at: true,
            expires_at: true,
          },
        }),
        prisma.searchSession.count({ where }),
      ]);
      return c.json(ok({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }));
    } catch (e) {
      return c.json(err(e instanceof Error ? e.message : 'Sessions error'), 500);
    }
  });

  // ── Cron job status + manual triggers ─────────────────────────────────────
  app.route('/cron', adminCronRoutes());

  return app;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function checkQdrant() {
  const result = await qdrantHealthCheck();
  if (!result.ok) return result;
  try {
    const { collections } = await qdrantClient().getCollections();
    const stats: Record<string, number> = {};
    for (const col of collections) {
      try {
        const info = await qdrantClient().getCollection(col.name);
        stats[col.name] = info.points_count ?? 0;
      } catch {
        stats[col.name] = -1;
      }
    }
    return { ok: true as const, collections: stats };
  } catch {
    return result;
  }
}

async function checkPostgres() {
  const start = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true as const, latencyMs: Date.now() - start };
}

async function checkRedis() {
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, connectTimeout: 3000 });
  try {
    await redis.connect();
    const start = Date.now();
    await redis.ping();
    const latencyMs = Date.now() - start;
    const [indexLen, schedulerLen] = await Promise.all([
      getRealQueueDepth(redis, 'toolpilot:index'),
      getRealQueueDepth(redis, 'toolpilot:scheduler'),
    ]);
    return {
      ok: true as const,
      latencyMs,
      queueDepth: { index: indexLen, scheduler: schedulerLen },
    };
  } finally {
    redis.disconnect();
  }
}

async function getRealQueueDepth(redis: Redis, stream: string): Promise<number> {
  try {
    const groups = (await redis.xinfo('GROUPS', stream)) as unknown[][];
    if (!groups?.length) return 0;
    const group = groups[0] as unknown[];
    const obj: Record<string, number> = {};
    for (let i = 0; i < group.length - 1; i += 2) obj[String(group[i])] = Number(group[i + 1]);
    return (obj.lag ?? 0) + (obj.pending ?? 0);
  } catch {
    return redis.xlen(stream).catch(() => 0);
  }
}

async function getQueueDepth() {
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, connectTimeout: 3000 });
  try {
    await redis.connect();
    const [indexLen, schedulerLen] = await Promise.all([
      getRealQueueDepth(redis, 'toolpilot:index'),
      getRealQueueDepth(redis, 'toolpilot:scheduler'),
    ]);
    return { index: indexLen, scheduler: schedulerLen };
  } catch {
    return { index: 0, scheduler: 0 };
  } finally {
    redis.disconnect();
  }
}

async function getStats() {
  const s1 = getMemgraphSession();
  let toolCount = 0;
  let edgeCount = 0;
  try {
    const r1 = await s1.run('MATCH (t:Tool) RETURN count(t) AS n');
    toolCount = toNum(r1.records[0]?.get('n'));
    const r2 = await s1.run('MATCH ()-[e]->() RETURN count(e) AS n');
    edgeCount = toNum(r2.records[0]?.get('n'));
  } finally {
    await s1.close();
  }
  const [pendingReview, pendingIndex] = await Promise.all([
    prisma.stagedNode.count({ where: { graduated: false } }),
    prisma.indexedTool.count({ where: { index_status: 'pending' } }),
  ]);
  return { toolCount, edgeCount, pendingReview, pendingIndex };
}

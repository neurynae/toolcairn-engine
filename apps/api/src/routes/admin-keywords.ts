/**
 * Admin keyword-sentence management — /v1/admin/keywords/*
 *
 * Three endpoints that let an admin curate the Qdrant `keyword_sentence`
 * payload field (the LLM-generated specificity sentence consumed by the
 * BM25 search index):
 *
 *   GET  /v1/admin/keywords/missing  — paginated list of tools whose
 *                                      keyword_sentence is missing/empty.
 *   GET  /v1/admin/keywords/export   — full NDJSON dump (download) of all
 *                                      tools missing keyword_sentence,
 *                                      including a description preview so
 *                                      the admin can author keywords.
 *   POST /v1/admin/keywords/ingest   — multipart upload of a JSONL file
 *                                      with `{id, name, keyword_sentence}`
 *                                      rows; surgically patches each Qdrant
 *                                      point via `setPayload`.
 *
 * keyword_sentence lives ONLY in Qdrant (the `tools` collection payload).
 * It is NOT in Memgraph — never write to Memgraph from this route.
 *
 * Updates use `client.setPayload()` (not `upsert`) — `setPayload` patches a
 * single payload field while preserving the rest. `upsert` would wipe the
 * whole payload (the `qdrant-upsert-wipes-payload` failure mode the team
 * has been bitten by before).
 */

import { keywordRowSchema } from '@toolcairn/core';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QdrantToolPoint {
  id: string | number;
  payload: Record<string, unknown> | null;
}

interface MissingToolSummary {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMissing(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return true;
  return value.trim().length === 0;
}

/**
 * Convert a `?offset=` query string into a Qdrant scroll-offset value.
 *
 * Qdrant's scroll offset is a POINT ID — either a UUID string or a u64
 * number — NOT a paging index. The web frontend sends `offset=0` for the
 * first page, which Qdrant rejects (no point with id `"0"` in the UUID-keyed
 * collection). Treat the common "first-page" sentinels as "no offset"; pass
 * everything else through unchanged so subsequent calls using the
 * `next_page_offset` returned by Qdrant continue to work.
 */
function parseScrollOffset(raw: string | undefined): string | number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0' || trimmed === 'null' || trimmed === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function summarize(point: QdrantToolPoint): MissingToolSummary {
  const pl = point.payload ?? {};
  const summary: MissingToolSummary = {
    id: String(point.id),
    name: typeof pl.name === 'string' ? pl.name : '',
  };
  if (typeof pl.description === 'string' && pl.description.length > 0) {
    summary.description = pl.description;
  }
  if (typeof pl.category === 'string' && pl.category.length > 0) {
    summary.category = pl.category;
  }
  return summary;
}

// ─── Route factory ────────────────────────────────────────────────────────────

/**
 * @param qdrant — optional Qdrant client (for tests). Defaults to the
 *                 shared engine `qdrantClient()`.
 */
export function adminKeywordsRoutes(qdrant: ReturnType<typeof qdrantClient> = qdrantClient()) {
  const app = new Hono();

  // ── GET /v1/admin/keywords/missing ────────────────────────────────────────
  // Single Qdrant scroll page, returns tools whose keyword_sentence is
  // missing or empty. The CLIENT controls pagination via offset (string or
  // number) — pass back the next_offset from the previous call.
  app.get('/missing', async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 200)));
    // Qdrant `scroll.offset` is a POINT ID (UUID / u64), not a numeric index.
    // The web frontend sends `?offset=0` for the first page; treat any
    // empty / "0" / "null" / "undefined" sentinel as "no offset" (= first
    // page). Otherwise pass the raw string through — Qdrant accepts UUID
    // strings and numeric strings indistinguishably for u64 ids.
    const offset = parseScrollOffset(c.req.query('offset'));

    try {
      const resp = await qdrant.scroll(COLLECTION_NAME, {
        limit,
        with_payload: { include: ['name', 'description', 'category', 'keyword_sentence'] },
        with_vector: false,
        ...(offset !== undefined ? { offset } : {}),
      });

      const points = resp.points as QdrantToolPoint[];
      const missing = points.filter((p) => isMissing(p.payload?.keyword_sentence)).map(summarize);

      const nextOffset = (resp.next_page_offset ?? null) as string | number | null;

      return c.json({
        ok: true,
        data: {
          tools: missing,
          next_offset: nextOffset,
          total_seen: points.length,
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : 'scroll_failed' }, 500);
    }
  });

  // ── GET /v1/admin/keywords/export ─────────────────────────────────────────
  // Streams ALL tools missing keyword_sentence as NDJSON. Iterates
  // server-side through every page until next_offset is null. Each line is
  // {"id","name","description"} — the description preview helps admins
  // write good keyword sentences offline.
  app.get('/export', async (c) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `keywords-missing-${timestamp}.jsonl`;

    c.header('Content-Type', 'application/x-ndjson');
    c.header('Content-Disposition', `attachment; filename=${filename}`);

    return stream(c, async (s) => {
      const PAGE_SIZE = 500;
      let offset: string | number | null | undefined = undefined;

      while (true) {
        const resp = await qdrant.scroll(COLLECTION_NAME, {
          limit: PAGE_SIZE,
          with_payload: { include: ['name', 'description', 'keyword_sentence'] },
          with_vector: false,
          ...(offset != null ? { offset } : {}),
        });

        const points = resp.points as QdrantToolPoint[];

        for (const point of points) {
          const pl = point.payload ?? {};
          if (!isMissing(pl.keyword_sentence)) continue;
          const row = {
            id: String(point.id),
            name: typeof pl.name === 'string' ? pl.name : '',
            description: typeof pl.description === 'string' ? pl.description : '',
          };
          await s.write(`${JSON.stringify(row)}\n`);
        }

        const next = resp.next_page_offset as string | number | null | undefined;
        if (next == null) break;
        offset = next;
      }
    });
  });

  // ── POST /v1/admin/keywords/ingest ────────────────────────────────────────
  // multipart/form-data with a `file` field: a JSONL file of
  // {id, name, keyword_sentence} rows. Each valid row is applied to Qdrant
  // via setPayload (NOT upsert — we are patching one field, not replacing
  // the whole point). Empty/whitespace keyword_sentence rows are skipped
  // without an API call.
  app.post('/ingest', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (e) {
      return c.json(
        { ok: false, error: e instanceof Error ? e.message : 'parse_body_failed' },
        400,
      );
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, error: 'missing_file_field' }, 400);
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/);

    let processed = 0;
    let skipped = 0;
    const failed: Array<{ line: number; error: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const trimmed = lines[i]?.trim() ?? '';
      if (trimmed.length === 0) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (e) {
        failed.push({
          line: lineNo,
          error: e instanceof Error ? `invalid_json: ${e.message}` : 'invalid_json',
        });
        continue;
      }

      const parsed = keywordRowSchema.safeParse(raw);
      if (!parsed.success) {
        failed.push({
          line: lineNo,
          error: `schema_invalid: ${parsed.error.issues.map((iss) => iss.message).join(', ')}`,
        });
        continue;
      }

      const entry = parsed.data;

      // Defensive: schema requires non-empty, but guard for whitespace-only.
      if (entry.keyword_sentence.trim().length === 0) {
        skipped++;
        continue;
      }

      try {
        await qdrant.setPayload(COLLECTION_NAME, {
          payload: { keyword_sentence: entry.keyword_sentence },
          points: [entry.id],
        });
        processed++;
      } catch (e) {
        failed.push({
          line: lineNo,
          error: e instanceof Error ? `setPayload_failed: ${e.message}` : 'setPayload_failed',
        });
      }
    }

    return c.json({ ok: true, data: { processed, skipped, failed } });
  });

  return app;
}

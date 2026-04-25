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
  // Returns EVERY tool missing keyword_sentence, in one response.
  //
  // Why server-side full scroll instead of paginated?
  //   - The missing-keyword set is small (hundreds, not thousands).
  //   - Filtering happens AFTER the Qdrant scroll boundary, so a
  //     "next_page_offset" exposed to the client is meaningless — page 1 of
  //     the scroll might yield 5 missing tools, page 2 might yield 50, the
  //     client has no way to know in advance.
  //   - Total count is essential for the admin UI; the only honest way to
  //     get it is to walk every page. Once we walk every page, returning
  //     them all is one extra response field, not extra work.
  //
  // Server-side scroll honors the same pattern as `/export` — iterate while
  // `next_page_offset` is non-null, accumulate filtered hits.
  app.get('/missing', async (c) => {
    const PAGE_SIZE = 500;
    try {
      const tools: MissingToolSummary[] = [];
      let totalSeen = 0;
      let offset: string | number | null | undefined = undefined;

      while (true) {
        const resp = await qdrant.scroll(COLLECTION_NAME, {
          limit: PAGE_SIZE,
          with_payload: { include: ['name', 'description', 'category', 'keyword_sentence'] },
          with_vector: false,
          ...(offset != null ? { offset } : {}),
        });
        const points = resp.points as QdrantToolPoint[];
        totalSeen += points.length;
        for (const point of points) {
          if (isMissing(point.payload?.keyword_sentence)) tools.push(summarize(point));
        }
        const next = resp.next_page_offset as string | number | null | undefined;
        if (next == null) break;
        offset = next;
      }

      return c.json({
        ok: true,
        data: {
          tools,
          total: tools.length,
          total_seen: totalSeen,
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : 'scroll_failed' }, 500);
    }
  });

  // ── GET /v1/admin/keywords/export ─────────────────────────────────────────
  // Returns a JSON ARRAY of full-shape tool objects, ready to drop into
  // `D:/ToolPilot/tools-export-v2.json` and run through
  // `scripts/generate-keywords.py`.
  //
  // Each element matches the EXACT shape the python script reads:
  //   { id, name, github_url, description, topics, docs, package_managers }
  //
  // The script uses these to fetch READMEs (docs.readme_url → blob→raw,
  // github_url → raw.githubusercontent.com guess, package_managers →
  // registry fallback) and to synthesise descriptions when no README is
  // reachable (description + topics). Exporting fewer fields breaks the
  // script's fallback chain and degrades keyword quality.
  app.get('/export', async (c) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tools-export-v2-${timestamp}.json`;

    c.header('Content-Type', 'application/json');
    c.header('Content-Disposition', `attachment; filename=${filename}`);

    return stream(c, async (s) => {
      const PAGE_SIZE = 500;
      let offset: string | number | null | undefined = undefined;
      let first = true;

      await s.write('[\n');

      while (true) {
        const resp = await qdrant.scroll(COLLECTION_NAME, {
          limit: PAGE_SIZE,
          with_payload: {
            include: [
              'name',
              'github_url',
              'description',
              'topics',
              'docs',
              'package_managers',
              'keyword_sentence',
            ],
          },
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
            github_url: typeof pl.github_url === 'string' ? pl.github_url : '',
            description: typeof pl.description === 'string' ? pl.description : '',
            topics: Array.isArray(pl.topics) ? pl.topics : [],
            docs: pl.docs && typeof pl.docs === 'object' ? pl.docs : {},
            package_managers:
              pl.package_managers && typeof pl.package_managers === 'object'
                ? pl.package_managers
                : {},
          };
          await s.write(`${first ? '' : ',\n'}  ${JSON.stringify(row)}`);
          first = false;
        }

        const next = resp.next_page_offset as string | number | null | undefined;
        if (next == null) break;
        offset = next;
      }

      await s.write('\n]\n');
    });
  });

  // ── POST /v1/admin/keywords/ingest ────────────────────────────────────────
  // multipart/form-data with a `file` field: a JSONL file of
  // {id, name, keyword_sentence} rows. Streams NDJSON progress lines as it
  // processes — the admin UI uses this to drive a real progress bar.
  //
  // Wire format (one JSON object per line):
  //   {"type":"start","total":N,"invalid":[{line,error}]}   — once at the top
  //   {"type":"progress","processed":n,"skipped":n,"failed":n}  — after each row
  //   {"type":"done","processed":n,"skipped":n,"failed":[{line,error}]}  — final
  //
  // Each valid row is applied to Qdrant via setPayload(wait:true) — we are
  // patching one field, not replacing the whole point, AND we want the
  // change durable before the next read-back from the admin UI.
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

    // Pre-validate every line BEFORE streaming so the `start` event can carry
    // an accurate total count + the list of pre-flight invalid lines.
    type ValidEntry = { lineNo: number; entry: { id: string; keyword_sentence: string } };
    const validEntries: ValidEntry[] = [];
    const invalid: Array<{ line: number; error: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const trimmed = lines[i]?.trim() ?? '';
      if (trimmed.length === 0) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (e) {
        invalid.push({
          line: lineNo,
          error: e instanceof Error ? `invalid_json: ${e.message}` : 'invalid_json',
        });
        continue;
      }
      const parsed = keywordRowSchema.safeParse(raw);
      if (!parsed.success) {
        invalid.push({
          line: lineNo,
          error: `schema_invalid: ${parsed.error.issues.map((iss) => iss.message).join(', ')}`,
        });
        continue;
      }
      validEntries.push({ lineNo, entry: parsed.data });
    }

    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no'); // tells nginx (if any) not to buffer the chunked body

    return stream(c, async (s) => {
      let processed = 0;
      let skipped = 0;
      const failed: Array<{ line: number; error: string }> = [...invalid];

      await s.write(`${JSON.stringify({ type: 'start', total: validEntries.length, invalid })}\n`);

      for (const { lineNo, entry } of validEntries) {
        if (entry.keyword_sentence.trim().length === 0) {
          skipped++;
        } else {
          try {
            await qdrant.setPayload(COLLECTION_NAME, {
              payload: { keyword_sentence: entry.keyword_sentence },
              points: [entry.id],
              wait: true,
            });
            processed++;
          } catch (e) {
            failed.push({
              line: lineNo,
              error: e instanceof Error ? `setPayload_failed: ${e.message}` : 'setPayload_failed',
            });
          }
        }

        await s.write(
          `${JSON.stringify({
            type: 'progress',
            processed,
            skipped,
            failed: failed.length,
          })}\n`,
        );
      }

      await s.write(`${JSON.stringify({ type: 'done', processed, skipped, failed })}\n`);
    });
  });

  return app;
}

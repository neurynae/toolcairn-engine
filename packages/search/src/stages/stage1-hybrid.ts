import type { ToolNode } from '@toolcairn/core';
import {
  type Bm25IndexData,
  COLLECTION_NAME,
  bm25Search,
  buildBm25Index,
  embedText,
  qdrantClient,
  rrfFusion,
} from '@toolcairn/vector';
import { expandQueryAliases } from '../aliases.js';
import { expandQueryWithGraphEntities } from '../query-expander.js';
import { classifyQueryIntent, getIntentWeights } from '../query-intent.js';
import type { Stage1Result } from '../types.js';
import type { ExactLookupMaps } from './stage0-exact.js';

export async function stage1HybridSearch(
  query: string,
  allTools: ToolNode[],
  lookupMaps?: ExactLookupMaps,
): Promise<Stage1Result> {
  const t0 = Date.now();

  // ── Intent classification ─────────────────────────────────────────────────
  const intent = classifyQueryIntent(query);
  const weights = getIntentWeights(intent);

  // ── Alias expansion (BM25 only — embeddings handle semantics natively) ────
  const expandedQuery = expandQueryAliases(query);

  // ── BM25 index + search ───────────────────────────────────────────────────
  const bm25Index: Bm25IndexData = buildBm25Index(allTools);
  const bm25Results = bm25Search(expandedQuery, bm25Index);
  const bm25Ids = bm25Results.map((r) => r.id);

  // ── Vector embedding — falls back to BM25-only when NOMIC_API_KEY absent ─
  let queryVector: number[] | null = null;
  try {
    queryVector = await embedText(query, 'search_query');
  } catch {
    // No API key — BM25-only mode
  }

  let vectorIds: string[] = [];
  if (queryVector) {
    try {
      const vectorResults = await qdrantClient().search(COLLECTION_NAME, {
        vector: queryVector,
        limit: 150, // increased from 100 for better recall
        with_payload: false,
      });
      vectorIds = (vectorResults as Array<{ id: string | number }>).map((r) => String(r.id));
    } catch {
      // Vector search unavailable — fall back to BM25-only
    }
  }

  // Fallback if both paths empty
  if (bm25Ids.length === 0 && vectorIds.length === 0) {
    const fallbackIds = [...allTools]
      .sort((a, b) => b.health.maintenance_score - a.health.maintenance_score)
      .map((t) => t.id);
    return { ids: fallbackIds, elapsed_ms: Date.now() - t0, intent };
  }

  // ── Intent-weighted RRF fusion ────────────────────────────────────────────
  let ids =
    vectorIds.length > 0
      ? rrfFusion([bm25Ids, vectorIds], [weights.bm25Weight, weights.vectorWeight])
      : bm25Ids;

  // ── Graph entity pre-boost (for queries containing known tool names) ───────
  if (lookupMaps) {
    try {
      const expandedIds = await expandQueryWithGraphEntities(query, lookupMaps);
      if (expandedIds.length > 0) {
        // Prepend expanded IDs so they definitely enter Stage 2;
        // deduplicate while preserving Stage 1 order for the rest
        const expandedSet = new Set(expandedIds);
        const remaining = ids.filter((id) => !expandedSet.has(id));
        ids = [...expandedIds, ...remaining];
      }
    } catch {
      // Non-fatal — continue without expansion
    }
  }

  return { ids, elapsed_ms: Date.now() - t0, intent };
}

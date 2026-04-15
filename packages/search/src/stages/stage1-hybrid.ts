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
import { computeLangConcordance } from '../language-concordance.js';
import { expandQueryWithGraphEntities } from '../query-expander.js';
import { classifyQueryIntent, getIntentWeights } from '../query-intent.js';
import type { Stage1Result } from '../types.js';
import type { ExactLookupMaps } from './stage0-exact.js';

export interface Stage1WeightOverride {
  bm25Weight: number;
  vectorWeight: number;
}

export async function stage1HybridSearch(
  query: string,
  allTools: ToolNode[],
  lookupMaps?: ExactLookupMaps,
  weightOverride?: Stage1WeightOverride,
  prebuiltBm25Index?: Bm25IndexData,
  topicFilter?: string[],
  topicMatchIds?: Set<string>,
  targetLanguages?: string[],
  toolCorpus?: ToolNode[],
): Promise<Stage1Result> {
  const t0 = Date.now();

  // ── Intent classification ─────────────────────────────────────────────────
  const intent = classifyQueryIntent(query);
  const weights = weightOverride ?? getIntentWeights(intent);

  // ── Alias expansion (BM25 only — embeddings handle semantics natively) ────
  const expandedQuery = expandQueryAliases(query);

  // ── BM25 index + search ───────────────────────────────────────────────────
  // When a pre-built index is provided (cached singleton), skip the expensive
  // buildBm25Index() call that tokenizes all 30K+ tools (~100ms + ~50MB).
  const bm25Index: Bm25IndexData = prebuiltBm25Index ?? buildBm25Index(allTools);
  const bm25Results = bm25Search(expandedQuery, bm25Index);
  // When topic filter is active, post-filter BM25 results to only include tools
  // with overlapping topics. This narrows the candidate pool to domain-relevant tools
  // before RRF fusion, preventing high-star irrelevant tools from dominating.
  const filteredBm25 =
    topicFilter && topicFilter.length > 0 && topicMatchIds && topicMatchIds.size > 0
      ? bm25Results.filter((r) => topicMatchIds.has(r.id))
      : bm25Results;
  const bm25Ids = filteredBm25.map((r) => r.id);

  // ── BM25 score normalization (saturation: score / (score + median)) ───────
  const nonZeroBm25 = filteredBm25
    .filter((r) => r.score > 0)
    .map((r) => r.score)
    .sort((a, b) => a - b);
  const medianBm25 =
    nonZeroBm25.length > 0 ? (nonZeroBm25[Math.floor(nonZeroBm25.length / 2)] ?? 1) : 1;
  const normalizedBm25Scores = new Map<string, number>();
  for (const r of filteredBm25) {
    normalizedBm25Scores.set(r.id, r.score / (r.score + medianBm25));
  }

  // ── Vector embedding — falls back to BM25-only when NOMIC_API_KEY absent ─
  let queryVector: number[] | null = null;
  try {
    queryVector = await embedText(query, 'search_query');
  } catch {
    // No API key — BM25-only mode
  }

  const vectorIds: string[] = [];
  const rawVectorScores = new Map<string, number>();
  if (queryVector) {
    try {
      // When topic filter is active, apply Qdrant payload filter (OR across topics)
      // so vector search only returns tools in the relevant domain.
      const qdrantFilter =
        topicFilter && topicFilter.length > 0
          ? {
              should: topicFilter.map((t) => ({
                key: 'topics' as const,
                match: { value: t },
              })),
            }
          : undefined;
      const vectorResults = await qdrantClient().search(COLLECTION_NAME, {
        vector: queryVector,
        limit: 150, // increased from 100 for better recall
        with_payload: false,
        filter: qdrantFilter,
      });
      for (const r of vectorResults as Array<{ id: string | number; score: number }>) {
        vectorIds.push(String(r.id));
        rawVectorScores.set(String(r.id), r.score);
      }
    } catch {
      // Vector search unavailable — fall back to BM25-only
    }
  }

  // ── Vector score normalization (min-max within result set) ────────────────
  const normalizedVectorScores = new Map<string, number>();
  if (rawVectorScores.size > 0) {
    const vecValues = [...rawVectorScores.values()];
    const minVec = Math.min(...vecValues);
    const maxVec = Math.max(...vecValues);
    const vecRange = maxVec - minVec || 1;
    for (const [id, s] of rawVectorScores) {
      normalizedVectorScores.set(id, (s - minVec) / vecRange);
    }
  }

  // ── Combined relevance scores (self-weighted mean of BM25 + vector) ───────
  // relevance = (b² + v²) / (b + v) — higher individual score dominates,
  // agreement amplifies. Zero when both are zero.
  const relevanceScores = new Map<string, number>();
  const allScoredIds = new Set([...normalizedBm25Scores.keys(), ...normalizedVectorScores.keys()]);
  for (const id of allScoredIds) {
    const b = normalizedBm25Scores.get(id) ?? 0;
    const v = normalizedVectorScores.get(id) ?? 0;
    const sum = b + v;
    const relevance = sum > 0 ? (b * b + v * v) / sum : 0;
    relevanceScores.set(id, relevance);
  }

  // ── Language concordance penalty ───────────────────────────────────────────
  // When target languages are detected from the query, penalize tools from
  // wrong ecosystems (e.g. PHP jwt in Node.js query → 0.3× multiplier).
  if (targetLanguages && targetLanguages.length > 0 && toolCorpus) {
    const toolMap = new Map(toolCorpus.map((t) => [t.id, t]));
    for (const [id, score] of relevanceScores) {
      const tool = toolMap.get(id);
      if (tool) {
        const concordance = computeLangConcordance(
          tool.language,
          tool.languages ?? [],
          targetLanguages,
        );
        relevanceScores.set(id, score * concordance);
      }
    }
  }

  // Fallback if both paths empty
  if (bm25Ids.length === 0 && vectorIds.length === 0) {
    const fallbackIds = [...allTools]
      .sort((a, b) => b.health.maintenance_score - a.health.maintenance_score)
      .map((t) => t.id);
    return {
      ids: fallbackIds,
      scores: new Map<string, number>(),
      elapsed_ms: Date.now() - t0,
      intent,
    };
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

  return { ids, scores: relevanceScores, elapsed_ms: Date.now() - t0, intent };
}

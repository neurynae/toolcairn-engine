import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import type { SearchContext, Stage2Result } from '../types.js';

const logger = createLogger({ name: '@toolcairn/search:stage2' });
const STAGE2_TOP_N = 25; // increased from 15 for better recall with 150-candidate Stage 1
const MIN_RESULTS = 3;

/**
 * Weight for Stage 1 relevance rank vs credibility in Stage 2 scoring.
 *
 * At 50/50 a BM25 rank-#1 tool with 14 stars beats a rank-#3 tool with 46k
 * stars because rankScore(0)=1.0 vs rankScore(2)=0.333 — the 0.667 rank gap
 * exceeds ANY credibility delta (max 1.0 × 0.5 = 0.5). At 20/80, credibility
 * dominates: Prisma (cred 0.72) wins over typescript-orm-benchmark (cred 0.17)
 * even when the benchmark ranks #1 and Prisma ranks #5.
 */
const RANK_WEIGHT = 0.2;
const CREDIBILITY_WEIGHT = 0.8;

/**
 * Apply Qdrant payload filters from clarification context.
 * Filterable fields: category, deployment_model, language, license.
 *
 * Graceful degradation: if the full filter set returns 0 results,
 * progressively drop the most restrictive filters (language, license)
 * and retry — matching the ClarificationEngine's fallback behaviour.
 */
export async function stage2ApplyFilters(
  candidateIds: string[],
  context: SearchContext | undefined,
  stage1Scores?: Map<string, number>,
): Promise<Stage2Result> {
  const t0 = Date.now();

  // Fetch ALL Stage 1 candidate payloads once — filtering happens in-memory.
  // This ensures high-ranked candidates are never lost to Qdrant's storage-order scroll.
  const { points } = await qdrantClient().scroll(COLLECTION_NAME, {
    filter: { must: [{ has_id: candidateIds }] },
    limit: candidateIds.length + 10,
    with_payload: true,
    with_vector: false,
  });

  const allCandidates = (
    points as Array<{ id: string | number; payload: Record<string, unknown> | null }>
  )
    .filter((p) => p.payload != null)
    .map((p) => {
      const tool = p.payload as unknown as ToolNode;
      const credScore = tool.health.credibility_score ?? 0;
      const stage1Score = stage1Scores?.get(String(p.id));

      // When Stage 1 provides actual relevance scores (sub-need path),
      // use: relevance x sqrt(credibility) x graphBoost. sqrt compresses
      // popularity into a tiebreaker — zero relevance = zero final score
      // regardless of stars. graphBoost (1.0–2.0) amplifies well-connected
      // canonical tools without overriding relevance.
      // Fallback to rank-based formula for paths without scores (search_tools, main pipeline).
      const rank = candidateIds.indexOf(String(p.id));
      const rankScore = rank >= 0 ? 1 / (rank + 1) : 0;
      const score =
        stage1Score !== undefined
          ? stage1Score *
            Math.sqrt(credScore) *
            (tool.search_weight ?? 1.0) *
            computeGraphBoost(tool)
          : (RANK_WEIGHT * rankScore + CREDIBILITY_WEIGHT * credScore) *
            (tool.search_weight ?? 1.0);

      return { tool, score };
    })
    .sort((a, b) => b.score - a.score);

  const applyFilters = (fns: Array<(t: ToolNode) => boolean>) =>
    allCandidates.filter(({ tool }) => fns.every((fn) => fn(tool))).slice(0, STAGE2_TOP_N);

  // Attempt 1: full filters
  const fullFilters = buildPayloadFilters(context);
  const fullHits = applyFilters(fullFilters);
  if (!context?.filters || fullHits.length >= MIN_RESULTS) {
    return { hits: fullHits, elapsed_ms: Date.now() - t0 };
  }

  // Attempt 2: drop language + license, keep topics/category + deployment
  const f = context.filters as Record<string, string | undefined>;
  const relaxed1: SearchContext = {
    ...context,
    filters: { deployment_model: f.deployment_model, category: f.category, topics: f.topics },
  };
  const relaxed1Hits = applyFilters(buildPayloadFilters(relaxed1));
  if (relaxed1Hits.length >= MIN_RESULTS) {
    logger.info({ count: relaxed1Hits.length }, 'stage2 relaxed: dropped language + license');
    return { hits: relaxed1Hits, elapsed_ms: Date.now() - t0 };
  }

  // Attempt 3: drop topics/category too — only deployment constraint remains
  const relaxed2: SearchContext = {
    ...context,
    filters: { deployment_model: f.deployment_model },
  };
  const relaxed2Hits = applyFilters(buildPayloadFilters(relaxed2));
  if (relaxed2Hits.length >= MIN_RESULTS) {
    logger.info({ count: relaxed2Hits.length }, 'stage2 relaxed: dropped topics/category');
    return { hits: relaxed2Hits, elapsed_ms: Date.now() - t0 };
  }

  // Final fallback: no filters — pure Stage 1 semantic ranking
  logger.info({ candidateIds: candidateIds.length }, 'stage2 falling back to semantic rank only');
  return { hits: allCandidates.slice(0, STAGE2_TOP_N), elapsed_ms: Date.now() - t0 };
}

/**
 * Build in-memory filter functions from clarification context.
 * These replace Qdrant payload filters so that the limit:N scroll doesn't
 * truncate semantically high-ranked candidates before filtering happens.
 */
function buildPayloadFilters(
  context: SearchContext | undefined,
): Array<(tool: ToolNode) => boolean> {
  if (!context?.filters) return [];

  const filters = context.filters as Record<string, string | undefined>;
  const { category, topics, deployment_model, language, license } = filters;
  const fns: Array<(tool: ToolNode) => boolean> = [];

  const topicOrCategory = topics ?? category;
  if (topicOrCategory) {
    fns.push((t) => t.category === topicOrCategory || (t.topics ?? []).includes(topicOrCategory));
  }
  if (deployment_model) {
    fns.push((t) =>
      t.deployment_models.includes(deployment_model as (typeof t.deployment_models)[0]),
    );
  }
  if (language) {
    fns.push((t) => t.language === language || (t.languages ?? []).includes(language));
  }
  if (license) {
    fns.push((t) => t.license === license);
  }

  return fns;
}

/**
 * Compute a graph-based boost multiplier from ecosystem_centrality,
 * pagerank_score, and is_canonical. Returns 1.0–2.0 range.
 *
 * - ecosystem_centrality: log-compressed (diminishing returns above ~50 edges)
 * - pagerank_score: already 0–1, scaled up to be comparable
 * - is_canonical: flat bonus for curated canonical tools
 *
 * Combined via self-weighted mean into a gentle amplifier that favors
 * well-connected canonical tools without overriding relevance.
 * Zero graph presence = 1.0 (no change).
 */
export function computeGraphBoost(tool: ToolNode): number {
  // Extract centrality — handle neo4j Integer {low, high} format from Qdrant
  const rawCentrality = tool.ecosystem_centrality;
  const centrality =
    typeof rawCentrality === 'number'
      ? rawCentrality
      : ((rawCentrality as { low?: number })?.low ?? 0);

  // Log-compress centrality: diminishing returns above ~50 edges
  // log(1) = 0, log(10) = 2.3, log(50) = 3.9, log(335) = 5.8, log(1000) = 6.9
  // Normalize to 0–1 by dividing by log(1000) ≈ 6.9
  const centralitySignal =
    centrality > 0 ? Math.min(1.0, Math.log(centrality) / Math.log(1000)) : 0;

  // PageRank: already 0–1 (typically 0–0.15 range), scale up to be comparable
  const pagerankSignal = Math.min(1.0, (tool.pagerank_score ?? 0) * 5);

  // Canonical bonus: small flat boost for curated canonical tools
  const canonicalBonus = tool.is_canonical ? 0.15 : 0;

  // Self-weighted mean of centrality and pagerank (biases toward stronger signal)
  const sum = centralitySignal + pagerankSignal;
  const graphScore =
    sum > 0 ? (centralitySignal * centralitySignal + pagerankSignal * pagerankSignal) / sum : 0;

  // Final boost: 1.0 (no graph) to 2.0 (maximum graph presence)
  // graphScore ranges 0–1, canonicalBonus is 0 or 0.15
  return 1.0 + Math.min(1.0, graphScore + canonicalBonus);
}

import type { ToolNode } from '@toolcairn/core';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import pino from 'pino';
import type { SearchContext, Stage2Result } from '../types.js';

const logger = pino({ name: '@toolcairn/search:stage2' });
const STAGE2_TOP_N = 15;
const MIN_RESULTS = 3;

/** Weight for Stage 1 relevance rank vs credibility in Stage 2 scoring. */
const RANK_WEIGHT = 0.7;
const CREDIBILITY_WEIGHT = 0.3;

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
      const rank = candidateIds.indexOf(String(p.id));
      const rankScore = rank >= 0 ? 1 / (rank + 1) : 0;
      const credScore = tool.health.credibility_score ?? 0;
      return {
        tool,
        score: RANK_WEIGHT * rankScore + CREDIBILITY_WEIGHT * credScore,
      };
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

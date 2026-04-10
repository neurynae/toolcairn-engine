const RRF_K = 60;
const RRF_TOP_N = 150; // increased from 50 → more candidates for Stage 2 to filter

/**
 * Reciprocal Rank Fusion — merges multiple ranked ID lists into a single fused ranking.
 * Standard formula: score(d) = Σ weight_i / (k + rank(d, list_i))
 *
 * @param rankedLists - Ranked lists of tool IDs (BM25, vector, etc.)
 * @param listWeights - Optional per-list multipliers (default 1.0 each).
 *   Use to boost or reduce the influence of a specific retrieval path
 *   based on query intent (e.g. boost vector for use-case queries).
 */
export function rrfFusion(rankedLists: string[][], listWeights?: number[]): string[] {
  const scores = new Map<string, number>();

  rankedLists.forEach((list, listIdx) => {
    const weight = listWeights?.[listIdx] ?? 1.0;
    list.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight * (1 / (RRF_K + rank)));
    });
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RRF_TOP_N)
    .map(([id]) => id);
}

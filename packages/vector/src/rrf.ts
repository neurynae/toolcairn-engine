const RRF_K = 60;
const RRF_TOP_N = 50;

/**
 * Reciprocal Rank Fusion — merges multiple ranked ID lists into a single fused ranking.
 * Standard formula: score(d) = Σ 1 / (k + rank(d, list_i))
 */
export function rrfFusion(rankedLists: string[][]): string[] {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    list.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RRF_TOP_N)
    .map(([id]) => id);
}

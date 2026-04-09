import type { Stage3Result, Stage4Result, ToolScoredResult } from '../types.js';

const TWO_OPTION_GAP_THRESHOLD = 1.2; // score[0] / score[1] < 1.2 triggers two-option
const PREFERENCE_BOOST = 0.08; // max boost for a frequently-used tool

/**
 * Precision selection with optional user preference boost.
 * - If userPreferences provided, apply a small boost to tools the user has selected before.
 *   This acts as a tiebreaker — never dominates but meaningfully reorders close results.
 * - If top two results are close (gap < 20%) AND represent stable/emerging split → return both.
 * - Otherwise → return top result only.
 */
export function stage4Select(
  stage3: Stage3Result,
  userPreferences?: Map<string, number>,
): Stage4Result {
  const t0 = Date.now();
  let { results } = stage3;

  if (results.length === 0) {
    return { results: [], is_two_option: false, elapsed_ms: 0 };
  }

  // Apply preference boost if user history available
  if (userPreferences && userPreferences.size > 0) {
    const maxPref = Math.max(...userPreferences.values());
    results = results.map((r) => {
      const pref = userPreferences.get(r.tool.name) ?? 0;
      const boost = maxPref > 0 ? (pref / maxPref) * PREFERENCE_BOOST : 0;
      return boost > 0 ? { ...r, score: r.score + boost } : r;
    });
    // Re-sort after boost
    results = [...results].sort((a, b) => b.score - a.score);
  }

  if (results.length === 1) {
    return { results: results.slice(0, 1), is_two_option: false, elapsed_ms: Date.now() - t0 };
  }

  const first = results[0] as ToolScoredResult;
  const second = results[1] as ToolScoredResult;

  const gap = second.score > 0 ? first.score / second.score : Number.POSITIVE_INFINITY;
  const isStableEmergingSplit = isStable(first) !== isStable(second);

  if (gap < TWO_OPTION_GAP_THRESHOLD && isStableEmergingSplit) {
    return { results: [first, second], is_two_option: true, elapsed_ms: Date.now() - t0 };
  }

  return { results: [first], is_two_option: false, elapsed_ms: Date.now() - t0 };
}

function isStable(result: ToolScoredResult): boolean {
  return result.tool.health.maintenance_score >= 0.6;
}

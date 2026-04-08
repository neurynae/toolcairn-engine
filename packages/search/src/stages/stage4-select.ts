import type { Stage3Result, Stage4Result, ToolScoredResult } from '../types.js';

const TWO_OPTION_GAP_THRESHOLD = 1.2; // score[0] / score[1] < 1.2 triggers two-option

/**
 * Precision selection:
 * - If top two results are close (gap < 20%) AND represent a stable/emerging split → return both
 * - Otherwise → return top result only
 */
export function stage4Select(stage3: Stage3Result): Stage4Result {
  const t0 = Date.now();
  const { results } = stage3;

  if (results.length === 0) {
    return { results: [], is_two_option: false, elapsed_ms: 0 };
  }

  if (results.length === 1) {
    return { results: results.slice(0, 1), is_two_option: false, elapsed_ms: Date.now() - t0 };
  }

  const first = results[0] as ToolScoredResult;
  const second = results[1] as ToolScoredResult;

  const gap = second.score > 0 ? first.score / second.score : Number.POSITIVE_INFINITY;
  const isStableEmergingSplit = isStable(first) !== isStable(second);

  if (gap < TWO_OPTION_GAP_THRESHOLD && isStableEmergingSplit) {
    return {
      results: [first, second],
      is_two_option: true,
      elapsed_ms: Date.now() - t0,
    };
  }

  return { results: [first], is_two_option: false, elapsed_ms: Date.now() - t0 };
}

function isStable(result: ToolScoredResult): boolean {
  return result.tool.health.maintenance_score >= 0.6;
}

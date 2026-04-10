import {
  GET_TOOL_GRAPH_RERANK,
  getMemgraphSession,
  mapRecordToToolNodeWithScore,
} from '@toolcairn/graph';
import { getIntentWeights } from '../query-intent.js';
import type { QueryIntent } from '../query-intent.js';
import type { Stage2Result, Stage3Result, ToolScoredResult } from '../types.js';

const BASE_GRAPH_WEIGHT = 0.4;
const BASE_STAGE2_WEIGHT = 0.4;
const CREDIBILITY_WEIGHT = 0.2;

/**
 * Re-rank Stage 2 results using graph connectivity, Stage 2 relevance, and credibility.
 * For comparison queries, graph weight is boosted (REPLACES edges matter more).
 *
 * Final score = graphWeight × graphScore + stage2Weight × stage2Score + 0.20 × credibility
 * (graph and stage2 normalized to [0,1], credibility already 0–1).
 */
export async function stage3GraphRerank(
  stage2: Stage2Result,
  intent?: QueryIntent,
): Promise<Stage3Result> {
  const t0 = Date.now();

  if (stage2.hits.length === 0) {
    return { results: [], elapsed_ms: 0 };
  }

  // Adjust graph vs stage2 weights based on query intent
  let graphWeight = BASE_GRAPH_WEIGHT;
  let stage2Weight = BASE_STAGE2_WEIGHT;
  if (intent) {
    const iw = getIntentWeights(intent);
    if (iw.graphWeightMultiplier !== 1.0) {
      // Scale graph weight up/down while keeping total = (graphWeight + stage2Weight)
      const total = BASE_GRAPH_WEIGHT + BASE_STAGE2_WEIGHT;
      graphWeight = Math.min(total - 0.1, BASE_GRAPH_WEIGHT * iw.graphWeightMultiplier);
      stage2Weight = total - graphWeight;
    }
  }

  const names = stage2.hits.map((h) => h.tool.name);

  const session = getMemgraphSession();
  let graphScores: Map<string, number>;
  try {
    const result = await session.run(GET_TOOL_GRAPH_RERANK.text, { names });
    graphScores = new Map(
      result.records.map((r) => {
        const { tool, graphScore } = mapRecordToToolNodeWithScore(r.toObject());
        return [tool.name, graphScore];
      }),
    );
  } finally {
    await session.close();
  }

  // Normalize stage2 scores to [0,1]
  const maxStage2 = Math.max(...stage2.hits.map((h) => h.score), 1);
  const graphValues = [...graphScores.values()];
  const maxGraph = Math.max(...graphValues, 1);

  const results: ToolScoredResult[] = stage2.hits.map((hit) => {
    const normalizedStage2 = hit.score / maxStage2;
    const rawGraph = graphScores.get(hit.tool.name) ?? 0;
    const normalizedGraph = maxGraph > 0 ? rawGraph / maxGraph : 0;
    const credScore = hit.tool.health.credibility_score ?? 0;

    const score =
      graphWeight * normalizedGraph +
      stage2Weight * normalizedStage2 +
      CREDIBILITY_WEIGHT * credScore;

    return { tool: hit.tool, score };
  });

  results.sort((a, b) => b.score - a.score);

  return { results, elapsed_ms: Date.now() - t0 };
}

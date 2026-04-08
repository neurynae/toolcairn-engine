import {
  GET_TOOL_GRAPH_RERANK,
  getMemgraphSession,
  mapRecordToToolNodeWithScore,
} from '@toolcairn/graph';
import type { Stage2Result, Stage3Result, ToolScoredResult } from '../types.js';

const GRAPH_WEIGHT = 0.6;
const STAGE2_WEIGHT = 0.4;

/**
 * Re-rank Stage 2 results using graph connectivity + temporal decay.
 * Final score = 0.6 × graphScore + 0.4 × stage2Score (both normalized to [0,1]).
 */
export async function stage3GraphRerank(stage2: Stage2Result): Promise<Stage3Result> {
  const t0 = Date.now();

  if (stage2.hits.length === 0) {
    return { results: [], elapsed_ms: 0 };
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
  // Normalize graph scores to [0,1]
  const graphValues = [...graphScores.values()];
  const maxGraph = Math.max(...graphValues, 1);

  const results: ToolScoredResult[] = stage2.hits.map((hit) => {
    const normalizedStage2 = hit.score / maxStage2;
    const rawGraph = graphScores.get(hit.tool.name) ?? 0;
    const normalizedGraph = maxGraph > 0 ? rawGraph / maxGraph : 0;
    const score = GRAPH_WEIGHT * normalizedGraph + STAGE2_WEIGHT * normalizedStage2;
    return { tool: hit.tool, score };
  });

  results.sort((a, b) => b.score - a.score);

  return { results, elapsed_ms: Date.now() - t0 };
}

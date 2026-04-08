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
import type { Stage1Result } from '../types.js';

export async function stage1HybridSearch(
  query: string,
  allTools: ToolNode[],
): Promise<Stage1Result> {
  const t0 = Date.now();

  const bm25Index: Bm25IndexData = buildBm25Index(allTools);

  // Try vector embedding — falls back to BM25-only when NOMIC_API_KEY is absent
  let queryVector: number[] | null = null;
  try {
    queryVector = await embedText(query, 'search_query');
  } catch {
    // No API key — BM25-only mode
  }

  const bm25Results = bm25Search(query, bm25Index);

  let vectorIds: string[] = [];
  if (queryVector) {
    try {
      const vectorResults = await qdrantClient().search(COLLECTION_NAME, {
        vector: queryVector,
        limit: 100,
        with_payload: false,
      });
      vectorIds = (vectorResults as Array<{ id: string | number }>).map((r) => String(r.id));
    } catch {
      // Vector search unavailable — fall back to BM25-only
    }
  }
  const bm25Ids = bm25Results.map((r) => r.id);

  // If both retrieval paths returned nothing, fall back to all tools sorted by maintenance score
  if (bm25Ids.length === 0 && vectorIds.length === 0) {
    const fallbackIds = [...allTools]
      .sort((a, b) => b.health.maintenance_score - a.health.maintenance_score)
      .map((t) => t.id);
    return { ids: fallbackIds, elapsed_ms: Date.now() - t0 };
  }

  const ids = vectorIds.length > 0 ? rrfFusion([bm25Ids, vectorIds]) : bm25Ids;

  return { ids, elapsed_ms: Date.now() - t0 };
}

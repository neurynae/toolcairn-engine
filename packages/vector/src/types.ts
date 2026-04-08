import type { ToolNode } from '@toolcairn/core';

export interface SearchHit<T> {
  id: string;
  score: number;
  payload: T;
}

export interface VectorSearchOptions {
  limit: number;
  filter?: Record<string, unknown>;
}

export type SearchResult = SearchHit<ToolNode>[];

export interface ScoredResult {
  id: string;
  score: number;
}

export interface Bm25Score {
  id: string;
  score: number;
}

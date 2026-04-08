// @toolcairn/vector — Qdrant client, Nomic embeddings, BM25+vector+RRF search

export { VectorError } from './errors.js';
export type {
  Bm25Score,
  SearchHit,
  SearchResult,
  ScoredResult,
  VectorSearchOptions,
} from './types.js';
export { qdrantClient, qdrantHealthCheck } from './client.js';
export { embedBatch, embedText, toolEmbedText } from './embedder.js';
export { type Bm25IndexData, bm25Search, buildBm25Index } from './bm25.js';
export { rrfFusion } from './rrf.js';
export {
  COLLECTION_NAME,
  ISSUES_COLLECTION_NAME,
  ensureCollection,
  ensureIssuesCollection,
  ensureAllCollections,
} from './collection.js';

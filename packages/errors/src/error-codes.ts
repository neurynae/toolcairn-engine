/**
 * Canonical error code catalog.
 * All AppError subclasses set one of these codes.
 * Codes are stable string constants — safe to log, persist, and return to clients.
 */
export const ErrorCode = {
  // ── Database ────────────────────────────────────────────────────────────────
  ERR_DB_CONNECTION: 'ERR_DB_CONNECTION',
  ERR_DB_QUERY: 'ERR_DB_QUERY',
  ERR_DB_TIMEOUT: 'ERR_DB_TIMEOUT',
  ERR_DB_CONSTRAINT: 'ERR_DB_CONSTRAINT',
  ERR_DB_NOT_FOUND: 'ERR_DB_NOT_FOUND',

  // ── Validation ──────────────────────────────────────────────────────────────
  ERR_VALIDATION_INPUT: 'ERR_VALIDATION_INPUT',
  ERR_VALIDATION_SCHEMA: 'ERR_VALIDATION_SCHEMA',

  // ── Auth ────────────────────────────────────────────────────────────────────
  ERR_AUTH_TOKEN_EXPIRED: 'ERR_AUTH_TOKEN_EXPIRED',
  ERR_AUTH_UNAUTHORIZED: 'ERR_AUTH_UNAUTHORIZED',
  ERR_AUTH_FORBIDDEN: 'ERR_AUTH_FORBIDDEN',

  // ── External services ───────────────────────────────────────────────────────
  ERR_EXTERNAL_GITHUB: 'ERR_EXTERNAL_GITHUB',
  ERR_EXTERNAL_NOMIC: 'ERR_EXTERNAL_NOMIC',
  ERR_EXTERNAL_QDRANT: 'ERR_EXTERNAL_QDRANT',
  ERR_EXTERNAL_MEMGRAPH: 'ERR_EXTERNAL_MEMGRAPH',
  ERR_EXTERNAL_RAZORPAY: 'ERR_EXTERNAL_RAZORPAY',

  // ── Queue ───────────────────────────────────────────────────────────────────
  ERR_QUEUE_PUBLISH: 'ERR_QUEUE_PUBLISH',
  ERR_QUEUE_CONSUME: 'ERR_QUEUE_CONSUME',
  ERR_QUEUE_TIMEOUT: 'ERR_QUEUE_TIMEOUT',

  // ── Search ──────────────────────────────────────────────────────────────────
  ERR_SEARCH_PIPELINE: 'ERR_SEARCH_PIPELINE',
  ERR_SEARCH_EMBEDDING: 'ERR_SEARCH_EMBEDDING',
  ERR_SEARCH_NO_RESULTS: 'ERR_SEARCH_NO_RESULTS',

  // ── Indexer ─────────────────────────────────────────────────────────────────
  ERR_INDEXER_CRAWL: 'ERR_INDEXER_CRAWL',
  ERR_INDEXER_PROCESS: 'ERR_INDEXER_PROCESS',
  ERR_INDEXER_WRITE: 'ERR_INDEXER_WRITE',

  // ── Network ─────────────────────────────────────────────────────────────────
  ERR_NETWORK_TIMEOUT: 'ERR_NETWORK_TIMEOUT',
  ERR_NETWORK_UNREACHABLE: 'ERR_NETWORK_UNREACHABLE',

  // ── MCP ─────────────────────────────────────────────────────────────────────
  ERR_MCP_HANDLER: 'ERR_MCP_HANDLER',
  ERR_MCP_AUTH: 'ERR_MCP_AUTH',

  // ── Generic ─────────────────────────────────────────────────────────────────
  ERR_INTERNAL: 'ERR_INTERNAL',
  ERR_NOT_FOUND: 'ERR_NOT_FOUND',
  ERR_RATE_LIMIT: 'ERR_RATE_LIMIT',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

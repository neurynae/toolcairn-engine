/**
 * Query intent classifier for the ToolCairn search pipeline.
 * Adjusts BM25/vector fusion weights and graph stage behaviour
 * based on what the user is likely trying to do.
 */

export type QueryIntent =
  | 'direct_name' // single word — probably a tool name
  | 'use_case' // "I need X", "find me X", "what is a good X"
  | 'comparison' // "X vs Y", "alternative to X", "instead of X"
  | 'feature_query' // describes traits: "fast", "lightweight", "typed"
  | 'category_query'; // broad category: "CSS framework", "ORM"

export interface IntentWeights {
  /** Weight for BM25 ranked list in RRF fusion (default 1.0) */
  bm25Weight: number;
  /** Weight for vector ranked list in RRF fusion (default 1.0) */
  vectorWeight: number;
  /** Whether to boost graph REPLACES edges in Stage 3 (for comparison queries) */
  boostReplaces: boolean;
  /** Stage 3 graph weight multiplier (default 1.0 = use configured weights) */
  graphWeightMultiplier: number;
}

const USE_CASE_PREFIXES = [
  'i need',
  'i want',
  'find me',
  'looking for',
  'what is',
  'what are',
  'how to',
  'help me',
  'recommend',
  'suggest',
  'best way to',
  'good library for',
  'good tool for',
];

const COMPARISON_TERMS = [
  'vs',
  'versus',
  'alternative',
  'alternatives',
  'instead of',
  'replace',
  'replacing',
  'compared to',
  'compare',
];

const FEATURE_ADJECTIVES = [
  'fast',
  'fastest',
  'lightweight',
  'minimal',
  'simple',
  'zero-dependency',
  'typed',
  'type-safe',
  'typesafe',
  'async',
  'reactive',
  'embedded',
  'serverless',
  'edge',
  'streaming',
  'realtime',
  'real-time',
  'offline',
  'secure',
  'production-ready',
  'battle-tested',
  'opinionated',
  'flexible',
];

/**
 * Classify the intent of a search query using lightweight heuristics.
 * Queries with 5+ words are almost never direct name lookups — treat as use_case.
 */
export function classifyQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();
  const qTokens = q.split(/\s+/);

  // Single word → likely a direct name lookup
  if (!q.includes(' ')) return 'direct_name';

  // Comparison intent
  if (COMPARISON_TERMS.some((term) => q.includes(term))) return 'comparison';

  // Use-case intent (natural language)
  if (USE_CASE_PREFIXES.some((prefix) => q.startsWith(prefix))) return 'use_case';
  if (q.startsWith('what ') || q.startsWith('which ') || q.startsWith('how ')) return 'use_case';

  // Long queries (5+ tokens) are almost always use-case descriptions
  if (qTokens.length >= 5) return 'use_case';

  // Feature query (describes desired traits)
  if (FEATURE_ADJECTIVES.some((adj) => qTokens.includes(adj))) return 'feature_query';

  // Default: category query
  return 'category_query';
}

/**
 * Return RRF fusion weights and stage modifiers for a given intent.
 *
 * Key insight: BM25 excels at exact name matching but poisons semantic queries.
 * For use_case/feature queries, vector embeddings capture meaning far better
 * than keyword overlap. A query like "build CLI tool in Node.js" should NOT
 * return Node.js runtime just because "node" appears in both.
 */
export function getIntentWeights(intent: QueryIntent): IntentWeights {
  switch (intent) {
    case 'direct_name':
      // BM25 is most reliable for exact name lookups (user knows the tool name)
      return {
        bm25Weight: 1.5,
        vectorWeight: 0.7,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };

    case 'use_case':
      // BM25 severely downweighted — keyword overlap is misleading for intent queries.
      // Trust vector embeddings almost entirely: they understand "build CLI tool"
      // is semantically close to commander/yargs, not to "nodejs/node".
      return {
        bm25Weight: 0.1,
        vectorWeight: 2.0,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };

    case 'comparison':
      // REPLACES graph edges are the key signal; vector finds semantic neighbours
      return {
        bm25Weight: 0.8,
        vectorWeight: 1.2,
        boostReplaces: true,
        graphWeightMultiplier: 1.5,
      };

    case 'feature_query':
      // Feature traits are partly described in text — vector still dominates
      return {
        bm25Weight: 0.3,
        vectorWeight: 1.7,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };

    case 'category_query':
      // Categories benefit from both signals but vector captures the concept better
      return {
        bm25Weight: 0.5,
        vectorWeight: 1.5,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };
  }
}

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
 * No external API calls — pure string analysis.
 */
export function classifyQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  // Single word → likely a direct name lookup (Stage 0 handles it, but
  // if it falls through to Stage 1, BM25 name matching is most important)
  if (!q.includes(' ')) return 'direct_name';

  // Comparison intent
  const qTokens = q.split(/\s+/);
  if (COMPARISON_TERMS.some((term) => q.includes(term))) return 'comparison';

  // Use-case intent (natural language)
  if (USE_CASE_PREFIXES.some((prefix) => q.startsWith(prefix))) return 'use_case';
  if (q.startsWith('what ') || q.startsWith('which ') || q.startsWith('how ')) return 'use_case';

  // Feature query (describes desired traits)
  if (FEATURE_ADJECTIVES.some((adj) => qTokens.includes(adj))) return 'feature_query';

  // Default: treat as category query (broad terms like "CSS framework")
  return 'category_query';
}

/**
 * Return RRF fusion weights and stage modifiers for a given intent.
 *
 * Intent weights rationale:
 * - direct_name: BM25 exact name match is most reliable → boost BM25
 * - use_case: semantic similarity matters most → boost vector
 * - comparison: graph REPLACES edges are highly relevant → boost graph
 * - feature_query: mix of BM25 (features in description) and vector
 * - category_query: balanced — both matter
 */
export function getIntentWeights(intent: QueryIntent): IntentWeights {
  switch (intent) {
    case 'direct_name':
      return {
        bm25Weight: 1.5,
        vectorWeight: 0.7,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };
    case 'use_case':
      return {
        bm25Weight: 0.7,
        vectorWeight: 1.5,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };
    case 'comparison':
      return {
        bm25Weight: 0.8,
        vectorWeight: 1.2,
        boostReplaces: true,
        graphWeightMultiplier: 1.5,
      };
    case 'feature_query':
      return {
        bm25Weight: 1.1,
        vectorWeight: 1.0,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };
    case 'category_query':
      return {
        bm25Weight: 1.0,
        vectorWeight: 1.0,
        boostReplaces: false,
        graphWeightMultiplier: 1.0,
      };
  }
}

import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/search:topic-filter' });

/**
 * Build a Set of all unique topics from the tool corpus.
 * O(n) scan, O(1) lookup for query matching.
 */
export function buildTopicVocabulary(tools: ToolNode[]): Set<string> {
  const vocab = new Set<string>();
  for (const tool of tools) {
    for (const topic of tool.topics ?? []) {
      const normalized = topic.toLowerCase().trim();
      if (normalized.length > 0) {
        vocab.add(normalized);
      }
    }
  }
  logger.debug({ vocabSize: vocab.size }, 'Topic vocabulary built');
  return vocab;
}

/**
 * Extract topic signals from a search query by matching tokens against the
 * known topic vocabulary. Handles:
 * - Direct matches: "postgresql" -> topic "postgresql"
 * - Hyphenated compounds: adjacent tokens "react" + "native" -> topic "react-native"
 * - Single-token forms: "nodejs" matches topic "nodejs", "graphql" matches "graphql"
 *
 * Returns empty array if no matches (caller should fall back to unfiltered search).
 */
export function extractTopicsFromQuery(query: string, vocabulary: Set<string>): string[] {
  if (vocabulary.size === 0) return [];

  const tokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1);

  if (tokens.length === 0) return [];

  const matched = new Set<string>();

  // Pass 1: direct single-token matches
  for (const token of tokens) {
    if (vocabulary.has(token)) {
      matched.add(token);
    }
  }

  // Pass 2: adjacent-token hyphenated compounds (e.g. "react" + "native" -> "react-native")
  for (let i = 0; i < tokens.length - 1; i++) {
    const compound = `${tokens[i]}-${tokens[i + 1]}`;
    if (vocabulary.has(compound)) {
      matched.add(compound);
    }
  }

  // Pass 3: triple-token compounds (e.g. "visual" + "studio" + "code" -> "visual-studio-code")
  for (let i = 0; i < tokens.length - 2; i++) {
    const compound = `${tokens[i]}-${tokens[i + 1]}-${tokens[i + 2]}`;
    if (vocabulary.has(compound)) {
      matched.add(compound);
    }
  }

  const result = [...matched];
  if (result.length > 0) {
    logger.debug({ query, topics: result }, 'Topics extracted from query');
  }
  return result;
}

/**
 * Precompute the set of tool IDs whose topics overlap with the given topic list.
 * Used to post-filter BM25 results (which don't have native payload filtering).
 */
export function computeTopicMatchIds(tools: ToolNode[], topics: string[]): Set<string> {
  const topicSet = new Set(topics);
  const matchIds = new Set<string>();
  for (const tool of tools) {
    const toolTopics = tool.topics ?? [];
    if (toolTopics.some((t) => topicSet.has(t.toLowerCase().trim()))) {
      matchIds.add(tool.id);
    }
  }
  return matchIds;
}

import type { ToolNode } from '@toolcairn/core';
import type { Bm25Score } from './types.js';

const K1 = 1.5;
const B = 0.75;

const FIELD_WEIGHTS = {
  name: 3.0,
  description: 1.0,
  topics: 0.5,
} as const;

type Field = keyof typeof FIELD_WEIGHTS;

interface DocTokens {
  id: string;
  name: string[];
  description: string[];
  topics: string[];
  len: number;
}

export interface Bm25IndexData {
  idf: Map<string, number>;
  docs: Map<string, DocTokens>;
  avgDocLen: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1);
}

/**
 * Tokenize a tool name for BM25 indexing.
 * Uses the full identifier as a single token instead of splitting on word boundaries.
 * e.g. "node-bunyan" → ["node-bunyan"] — not ["node", "bunyan"]
 *
 * This prevents platform prefix tokens like "node" from matching unrelated tools
 * (node-bunyan, node-redis, node-cron) when a query mentions "Node.js" as context.
 * Semantic relevance is handled by vector search; BM25 handles exact name lookup.
 */
function tokenizeName(name: string): string[] {
  const lower = name.toLowerCase().trim();
  return lower.length > 0 ? [lower] : [];
}

export function buildBm25Index(tools: ToolNode[]): Bm25IndexData {
  const docs = new Map<string, DocTokens>();
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const tool of tools) {
    const nameTokens = tokenizeName(tool.name);
    const descTokens = tokenize(tool.description);
    const topicTokens = tokenize((tool.topics ?? []).join(' '));
    const len = nameTokens.length + descTokens.length + topicTokens.length;

    docs.set(tool.id, {
      id: tool.id,
      name: nameTokens,
      description: descTokens,
      topics: topicTokens,
      len,
    });
    totalLen += len;

    const seen = new Set<string>();
    for (const token of [...nameTokens, ...descTokens, ...topicTokens]) {
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }

  const N = tools.length;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  const avgDocLen = N > 0 ? totalLen / N : 1;
  return { idf, docs, avgDocLen };
}

export function bm25Search(query: string, index: Bm25IndexData): Bm25Score[] {
  const queryTokens = tokenize(query);
  const scores = new Map<string, number>();

  for (const [docId, doc] of index.docs) {
    let score = 0;

    for (const token of queryTokens) {
      const idfScore = index.idf.get(token) ?? 0;
      if (idfScore === 0) continue;

      for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
        const fieldTokens = doc[field];
        const tf = fieldTokens.filter((t) => t === token).length;
        if (tf === 0) continue;

        const fieldLen = fieldTokens.length;
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / index.avgDocLen)));

        score += idfScore * tfNorm * FIELD_WEIGHTS[field];
      }
    }

    if (score > 0) scores.set(docId, score);
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

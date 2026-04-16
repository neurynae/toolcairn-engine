import type { ToolNode } from '@toolcairn/core';
import type { Bm25Score } from './types.js';

const K1 = 1.5;
const B = 0.75;

const FIELD_WEIGHTS = {
  name: 3.0, // full compound name — exact match (e.g. "vue-router")
  nameParts: 1.5, // split components — partial match (e.g. "vue", "router")
  packageNames: 2.5, // npm/pip/cargo canonical name
  description: 1.0,
  keywordSentence: 4.0, // LLM-generated keywords — dominant search signal
  topics: 0.5,
  language: 1.0, // programming language / ecosystem signal
} as const;

type Field = keyof typeof FIELD_WEIGHTS;

interface DocTokens {
  id: string;
  name: string[]; // [full compound name only]
  nameParts: string[]; // [split name components, excluding the full name]
  packageNames: string[];
  description: string[];
  keywordSentence: string[]; // LLM-generated keyword tokens from README analysis
  topics: string[];
  language: string[]; // programming language tokens
  len: number;
}

export interface Bm25IndexData {
  idf: Map<string, number>;
  df: Map<string, number>;
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
 * Tokenize keyword_sentence field: splits on commas only, preserving
 * hyphens, underscores, and concatenated words as single tokens.
 *
 * "database_indexing, audio-intelligence-lab, orm" →
 * ["database_indexing", "audio-intelligence-lab", "orm"]
 *
 * Compound keywords carry domain meaning (database_indexing ≠ database + indexing).
 * When BM25 can't match compounds, vector search catches them semantically.
 */
function tokenizeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/**
 * Tokenize a tool name into:
 *   - `name` field: the full compound name (single token) — weight 3.0
 *   - `nameParts` field: split components — weight 1.5
 *
 * Splitting compound names enables "react" to match "facebook/react" while
 * using a lower weight for parts avoids over-boosting tools that merely
 * contain a language name (e.g. "rust-rpxy" shouldn't dominate on "rust"
 * queries when actix-web or axum are the canonical answers).
 */
function tokenizeName(name: string): { full: string[]; parts: string[] } {
  const lower = name.toLowerCase().trim();
  if (!lower) return { full: [], parts: [] };

  const split = lower.split(/[-_./]+/).filter((t) => t.length > 1);
  const parts = split.filter((t) => t !== lower);

  return { full: [lower], parts };
}

export function buildBm25Index(tools: ToolNode[]): Bm25IndexData {
  const docs = new Map<string, DocTokens>();
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const tool of tools) {
    const { full: nameTokens, parts: namePartTokens } = tokenizeName(tool.name);
    const pkgTokens = (tool.package_managers ?? [])
      .flatMap((ch) => tokenize(ch.packageName))
      .filter((t) => t.length > 1);
    const descTokens = tokenize(tool.description);
    const topicTokens = tokenize((tool.topics ?? []).join(' '));
    const langTokens = tokenize(
      [tool.language, ...(tool.languages ?? [])].filter(Boolean).join(' '),
    );
    const kwTokens = tokenizeKeywords(tool.keyword_sentence ?? '');
    const len =
      nameTokens.length +
      namePartTokens.length +
      pkgTokens.length +
      descTokens.length +
      kwTokens.length +
      topicTokens.length +
      langTokens.length;

    docs.set(tool.id, {
      id: tool.id,
      name: nameTokens,
      nameParts: namePartTokens,
      packageNames: pkgTokens,
      description: descTokens,
      keywordSentence: kwTokens,
      topics: topicTokens,
      language: langTokens,
      len,
    });
    totalLen += len;

    const seen = new Set<string>();
    for (const token of [
      ...nameTokens,
      ...namePartTokens,
      ...pkgTokens,
      ...descTokens,
      ...kwTokens,
      ...topicTokens,
      ...langTokens,
    ]) {
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
  return { idf, df, docs, avgDocLen };
}

/**
 * Maximum possible IDF in this corpus — log(N + 1).
 * Used to normalize name IDF into a 0-1 range for proportional weighting.
 * Computed once per index build (self-calibrating as corpus grows).
 */
function computeMaxIdf(corpusSize: number): number {
  return Math.log(corpusSize + 1);
}

export function bm25Search(query: string, index: Bm25IndexData): Bm25Score[] {
  const queryTokens = tokenize(query);
  const queryKwTokens = tokenizeKeywords(query);
  const scores = new Map<string, number>();
  const maxIdf = computeMaxIdf(index.docs.size);

  for (const [docId, doc] of index.docs) {
    let score = 0;
    let bestTopicMatch = 0;

    // ── Standard fields: use standard query tokens ──────────────────────
    for (const token of queryTokens) {
      const idfScore = index.idf.get(token) ?? 0;
      if (idfScore === 0) continue;

      for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
        if (field === 'keywordSentence') continue; // handled separately below
        const fieldTokens = doc[field];
        const tf = fieldTokens.filter((t) => t === token).length;
        if (tf === 0) continue;

        const fieldLen = fieldTokens.length;
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / index.avgDocLen)));

        if (field === 'topics') {
          const tokenScore = idfScore * tfNorm * FIELD_WEIGHTS[field];
          bestTopicMatch = Math.max(bestTopicMatch, tokenScore);
        } else {
          let weight = FIELD_WEIGHTS[field];
          if (field === 'name') {
            const nameIdf = index.idf.get(token) ?? 0;
            const normalizedIdf = maxIdf > 0 ? nameIdf / maxIdf : 0;
            weight = 1.0 + 2.0 * normalizedIdf;
          }
          score += idfScore * tfNorm * weight;
        }
      }
    }

    // ── keywordSentence: use keyword-aware query tokens ─────────────────
    // Compound keywords (database_indexing, audio-intelligence-lab) are
    // single tokens — they only match when the query also contains the
    // exact compound. Vector fallback handles non-exact matches.
    for (const token of queryKwTokens) {
      const idfScore = index.idf.get(token) ?? 0;
      if (idfScore === 0) continue;

      const fieldTokens = doc.keywordSentence;
      const tf = fieldTokens.filter((t) => t === token).length;
      if (tf === 0) continue;

      const fieldLen = fieldTokens.length;
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / index.avgDocLen)));
      score += idfScore * tfNorm * FIELD_WEIGHTS.keywordSentence;
    }

    score += bestTopicMatch;
    if (score > 0) scores.set(docId, score);
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

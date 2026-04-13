// Lightweight BM25 index over UseCase node names.
// Used by the multi-facet stack builder to detect which functional layers
// a query touches — "real-time chat with auth and database" → ["authentication", "database", "realtime", "chat"].
//
// This is standard IR (same mechanism as tool BM25 in Stage 1), not keyword mapping.
// The corpus is the 49K+ UseCase names from the graph, built from GitHub topics at index time.

import type { MemgraphUseCaseRepository } from '@toolcairn/graph';

// ─── BM25 parameters (standard) ────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

// ─── Types ──────────────────────────────────────────────────────────────────

interface UseCaseEntry {
  name: string;
  tokens: string[];
}

export interface UseCaseBm25Index {
  entries: UseCaseEntry[];
  idf: Map<string, number>;
  avgLen: number;
}

export interface UseCaseBm25Match {
  name: string;
  score: number;
}

// ─── Tokenizer (matches tool BM25 strategy) ─────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[-_./\s]+/)
    .filter((t) => t.length > 1);
}

// ─── Index builder ──────────────────────────────────────────────────────────

export function buildUseCaseBm25Index(useCases: Array<{ name: string }>): UseCaseBm25Index {
  const entries: UseCaseEntry[] = useCases.map((uc) => ({
    name: uc.name,
    tokens: tokenize(uc.name),
  }));

  // Compute IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const docCount = entries.length;
  const docFreq = new Map<string, number>();
  for (const entry of entries) {
    const seen = new Set(entry.tokens);
    for (const token of seen) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [token, df] of docFreq) {
    idf.set(token, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
  }

  const totalLen = entries.reduce((sum, e) => sum + e.tokens.length, 0);
  const avgLen = entries.length > 0 ? totalLen / entries.length : 1;

  return { entries, idf, avgLen };
}

// ─── Search ─────────────────────────────────────────────────────────────────

export function searchUseCaseBm25(
  query: string,
  index: UseCaseBm25Index,
  limit = 6,
): UseCaseBm25Match[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results: UseCaseBm25Match[] = [];

  for (const entry of index.entries) {
    let score = 0;
    const dl = entry.tokens.length;

    for (const qt of queryTokens) {
      const tf = entry.tokens.filter((t) => t === qt).length;
      if (tf === 0) continue;
      const idfScore = index.idf.get(qt) ?? 0;
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / index.avgLen));
      score += idfScore * tfNorm;
    }

    if (score > 0) {
      results.push({ name: entry.name, score });
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Diversity-aware selection: greedily pick facets whose tokens don't overlap
  // heavily with already-selected facets. Without this, compound UseCase names
  // like "real-time-chat", "real-time-chat-app", "real-time" consume all slots
  // and crowd out distinct concepts like "authentication" and "database".
  return diversifyFacets(results, limit);
}

/**
 * Greedy diversity filter: from a BM25-ranked list, select facets that are
 * tokenically distinct from each other. Two facets with >50% shared tokens
 * are considered the same concept — keep the higher-scored one, skip the rest.
 *
 * Scans up to 5× limit candidates to find enough diverse facets.
 */
function diversifyFacets(ranked: UseCaseBm25Match[], limit: number): UseCaseBm25Match[] {
  const selected: Array<{ match: UseCaseBm25Match; tokens: Set<string> }> = [];
  const scanLimit = Math.min(ranked.length, limit * 5);

  for (let i = 0; i < scanLimit && selected.length < limit; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounds checked
    const candidate = ranked[i]!;
    const candidateTokens = new Set(tokenize(candidate.name));

    // Check token overlap with every already-selected facet
    let isDuplicate = false;
    for (const { tokens: selectedTokens } of selected) {
      const intersection = [...candidateTokens].filter((t) => selectedTokens.has(t));
      const smaller = Math.min(candidateTokens.size, selectedTokens.size);
      if (smaller > 0 && intersection.length / smaller > 0.5) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      selected.push({ match: candidate, tokens: candidateTokens });
    }
  }

  return selected.map((s) => s.match);
}

// ─── Cached singleton ───────────────────────────────────────────────────────

let cachedIndex: UseCaseBm25Index | null = null;

/**
 * Get or build the UseCase BM25 index. Cached at module level —
 * rebuilt only on first call per process lifetime.
 */
export async function getUseCaseBm25Index(
  usecaseRepo: MemgraphUseCaseRepository,
): Promise<UseCaseBm25Index> {
  if (cachedIndex) return cachedIndex;

  const result = await usecaseRepo.getAllUseCases();
  const useCases = result.ok ? result.data : [];
  cachedIndex = buildUseCaseBm25Index(useCases);
  return cachedIndex;
}

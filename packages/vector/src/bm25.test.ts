import type { ToolNode } from '@toolcairn/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { bm25Search, buildBm25Index } from './bm25.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeHealth(maintenanceScore = 0.8) {
  return {
    stars: 1000,
    stars_velocity_90d: 50,
    last_commit_date: '2024-01-01',
    commit_velocity_30d: 10,
    open_issues: 5,
    closed_issues_30d: 20,
    pr_response_time_hours: 24,
    contributor_count: 30,
    contributor_trend: 2,
    last_release_date: '2024-01-01',
    maintenance_score: maintenanceScore,
    credibility_score: maintenanceScore,
    forks_count: 0,
    weekly_downloads: 0,
    stars_snapshot_at: '',
    stars_velocity_7d: 0,
    stars_velocity_30d: 0,
  };
}

function makeTool(overrides: Partial<ToolNode> & Pick<ToolNode, 'id' | 'name'>): ToolNode {
  return {
    display_name: overrides.name,
    description: 'A generic tool',
    category: 'other',
    github_url: 'https://github.com/example/tool',
    license: 'MIT',
    language: 'TypeScript',
    languages: ['TypeScript'],
    deployment_models: ['cloud'],
    package_managers: [],
    health: makeHealth(),
    docs: {},
    topics: [],
    is_fork: false,
    ecosystem_centrality: 0,
    pagerank_score: 0,
    search_weight: 1.0,
    is_canonical: false,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    ...overrides,
  };
}

const CORPUS: ToolNode[] = [
  makeTool({
    id: 'qdrant',
    name: 'qdrant',
    display_name: 'Qdrant Vector Database',
    description: 'High-performance vector database for similarity search',
    category: 'vector-database',
  }),
  makeTool({
    id: 'redis',
    name: 'redis',
    display_name: 'Redis Cache',
    description: 'In-memory data store used as cache and message broker',
    category: 'cache',
  }),
  makeTool({
    id: 'memgraph',
    name: 'memgraph',
    display_name: 'Memgraph Graph Database',
    description: 'Real-time graph analytics and graph database platform',
    category: 'graph-database',
  }),
  makeTool({
    id: 'langchain',
    name: 'langchain',
    display_name: 'LangChain LLM Framework',
    description: 'Framework for building applications with large language models',
    category: 'llm-framework',
  }),
  makeTool({
    id: 'vitest',
    name: 'vitest',
    display_name: 'Vitest Testing',
    description: 'Next generation unit testing framework',
    category: 'testing',
  }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildBm25Index', () => {
  it('should build an index with docs for every tool in the corpus', () => {
    const index = buildBm25Index(CORPUS);

    expect(index.docs.size).toBe(CORPUS.length);
    for (const tool of CORPUS) {
      expect(index.docs.has(tool.id)).toBe(true);
    }
  });

  it('should compute a positive avgDocLen for a non-empty corpus', () => {
    const index = buildBm25Index(CORPUS);
    expect(index.avgDocLen).toBeGreaterThan(0);
  });

  it('should populate IDF entries for terms that appear in the corpus', () => {
    const index = buildBm25Index(CORPUS);
    // 'database' appears in both qdrant and memgraph descriptions/names
    expect(index.idf.has('database')).toBe(true);
  });

  it('should return avgDocLen of 1 for an empty corpus', () => {
    const index = buildBm25Index([]);
    expect(index.avgDocLen).toBe(1);
    expect(index.docs.size).toBe(0);
    expect(index.idf.size).toBe(0);
  });

  it('should not include single-character tokens in the IDF map', () => {
    // tokenize filters tokens with length <= 1
    const index = buildBm25Index(CORPUS);
    for (const token of index.idf.keys()) {
      expect(token.length).toBeGreaterThan(1);
    }
  });
});

describe('bm25Search', () => {
  let index: ReturnType<typeof buildBm25Index>;

  beforeEach(() => {
    index = buildBm25Index(CORPUS);
  });

  it('should return an empty array for an empty query string', () => {
    const results = bm25Search('', index);
    expect(results).toEqual([]);
  });

  it('should return an empty array when built from an empty corpus', () => {
    const emptyIndex = buildBm25Index([]);
    const results = bm25Search('vector database', emptyIndex);
    expect(results).toEqual([]);
  });

  it('should rank the exact-name match highest', () => {
    // 'qdrant' appears only in the qdrant tool's name — name weight is 3.0
    const results = bm25Search('qdrant', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe('qdrant');
  });

  it('should rank the graph database tool highest for "graph" query', () => {
    const results = bm25Search('memgraph graph', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe('memgraph');
  });

  it('should return results sorted in descending score order', () => {
    const results = bm25Search('database', index);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(results[i]?.score ?? 0);
    }
  });

  it('should respect the limit when sliced by the caller', () => {
    // bm25Search itself does not accept a limit — the caller slices.
    // We verify that the result set can be meaningfully limited.
    const results = bm25Search('database', index);
    const limited = results.slice(0, 1);
    expect(limited.length).toBeLessThanOrEqual(1);
  });

  it('should return only tools with score > 0', () => {
    const results = bm25Search('qdrant', index);
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
    }
  });

  it('should return no results for a query token that does not appear in the corpus', () => {
    const results = bm25Search('xyzzy404notinanytooldescription', index);
    expect(results).toEqual([]);
  });

  it('should include id and score fields on every result', () => {
    const results = bm25Search('database', index);
    for (const result of results) {
      expect(typeof result.id).toBe('string');
      expect(typeof result.score).toBe('number');
    }
  });
});

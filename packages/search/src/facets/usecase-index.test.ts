import { describe, expect, it } from 'vitest';
import { buildUseCaseBm25Index, searchUseCaseBm25 } from './usecase-index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_USECASES = [
  { name: 'authentication', tool_count: 500 },
  { name: 'database', tool_count: 490 },
  { name: 'realtime', tool_count: 100 },
  { name: 'websocket', tool_count: 150 },
  { name: 'chat', tool_count: 200 },
  { name: 'postgresql', tool_count: 428 },
  { name: 'browser-extension', tool_count: 120 },
  { name: 'machine-learning', tool_count: 743 },
  { name: 'docker', tool_count: 818 },
  { name: 'kubernetes', tool_count: 697 },
  { name: 'ecommerce', tool_count: 80 },
  { name: 'payments', tool_count: 60 },
  { name: 'react', tool_count: 1314 },
  { name: 'typescript', tool_count: 300 },
  { name: 'orm', tool_count: 50 },
  { name: 'testing', tool_count: 379 },
  { name: 'monitoring', tool_count: 200 },
  { name: 'ci-cd', tool_count: 100 },
  { name: 'push-notifications', tool_count: 80 },
  { name: 'mobile', tool_count: 300 },
];

describe('UseCase BM25 Index', () => {
  const index = buildUseCaseBm25Index(SAMPLE_USECASES);

  it('returns empty results for empty corpus', () => {
    const empty = buildUseCaseBm25Index([]);
    const results = searchUseCaseBm25('authentication', empty);
    expect(results).toHaveLength(0);
  });

  it('returns empty results for empty query', () => {
    const results = searchUseCaseBm25('', index);
    expect(results).toHaveLength(0);
  });

  it('matches exact UseCase name with high score', () => {
    const results = searchUseCaseBm25('authentication', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe('authentication');
  });

  it('matches multiple facets from a multi-concept query', () => {
    const results = searchUseCaseBm25('real-time chat with authentication and database', index, 6);
    const names = results.map((r) => r.name);
    // Should find at least authentication and database
    expect(names).toContain('authentication');
    expect(names).toContain('database');
  });

  it('tokenizes hyphenated UseCase names correctly', () => {
    const results = searchUseCaseBm25('machine learning', index);
    const names = results.map((r) => r.name);
    expect(names).toContain('machine-learning');
  });

  it('common tokens across many UseCases have low IDF and do not dominate', () => {
    // Build an index where "tool" appears in many names
    const manyToolUCs = [
      { name: 'tool-a' },
      { name: 'tool-b', tool_count: 100 },
      { name: 'tool-c', tool_count: 100 },
      { name: 'tool-d', tool_count: 100 },
      { name: 'auth-special', tool_count: 100 },
    ];
    const idx = buildUseCaseBm25Index(manyToolUCs);
    // Searching "auth special" should rank auth-special higher than any tool-X
    const results = searchUseCaseBm25('auth special', idx, 3);
    expect(results[0]?.name).toBe('auth-special');
  });

  it('respects limit parameter', () => {
    const results = searchUseCaseBm25('authentication database realtime', index, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('scores decrease by relevance', () => {
    const results = searchUseCaseBm25('authentication', index);
    for (let i = 1; i < results.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: loop bounds valid
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { buildUseCaseBm25Index, searchUseCaseBm25 } from './usecase-index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_USECASES = [
  { name: 'authentication' },
  { name: 'database' },
  { name: 'realtime' },
  { name: 'websocket' },
  { name: 'chat' },
  { name: 'postgresql' },
  { name: 'browser-extension' },
  { name: 'machine-learning' },
  { name: 'docker' },
  { name: 'kubernetes' },
  { name: 'ecommerce' },
  { name: 'payments' },
  { name: 'react' },
  { name: 'typescript' },
  { name: 'orm' },
  { name: 'testing' },
  { name: 'monitoring' },
  { name: 'ci-cd' },
  { name: 'push-notifications' },
  { name: 'mobile' },
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
      { name: 'tool-b' },
      { name: 'tool-c' },
      { name: 'tool-d' },
      { name: 'auth-special' },
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

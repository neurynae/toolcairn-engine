import type { ToolNode } from '@toolcairn/core';
import { describe, expect, it } from 'vitest';
import { DIMENSIONS, IG_THRESHOLD, InformationGainCalculator } from './gain.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeHealth(maintenanceScore = 0.8) {
  return {
    stars: 500,
    stars_velocity_90d: 20,
    last_commit_date: '2024-01-01',
    commit_velocity_30d: 5,
    open_issues: 3,
    closed_issues_30d: 10,
    pr_response_time_hours: 48,
    contributor_count: 10,
    contributor_trend: 1,
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
    github_url: 'https://github.com/example',
    license: 'MIT',
    language: 'TypeScript',
    languages: ['TypeScript'],
    deployment_models: ['cloud'],
    package_managers: {},
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InformationGainCalculator', () => {
  describe('compute', () => {
    it('should return an empty Map for an empty candidate set', () => {
      const calc = new InformationGainCalculator();
      const result = calc.compute([]);
      expect(result.size).toBe(0);
    });

    it('should return an entry for every DIMENSION when given non-empty candidates', () => {
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', category: 'vector-database' }),
        makeTool({ id: 'b', name: 'b', category: 'graph-database' }),
      ];
      const result = calc.compute(tools);
      for (const dim of DIMENSIONS) {
        expect(result.has(dim)).toBe(true);
      }
    });

    it('should return zero information gain when all tools share the same value on a dimension', () => {
      // All tools have category='other', language='TypeScript', license='MIT',
      // deployment_models=['cloud'] (first entry = 'cloud'), maintenance_score=0.8 (stable).
      // Every dimension is uniform → entropy = 0 for all.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'x', name: 'x' }),
        makeTool({ id: 'y', name: 'y' }),
        makeTool({ id: 'z', name: 'z' }),
      ];
      const result = calc.compute(tools);
      for (const [, score] of result) {
        expect(score).toBe(0);
      }
    });

    it('should return positive gain when values are evenly split across a dimension', () => {
      // topics dimension has 2 tools each with a distinct first topic.
      // Entropy of [1,1] = -0.5*log2(0.5) - 0.5*log2(0.5) = 1 bit.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', topics: ['vector-database'] }),
        makeTool({ id: 'b', name: 'b', topics: ['graph-database'] }),
      ];
      const result = calc.compute(tools);
      const topicsGain = result.get('topics') ?? 0;
      expect(topicsGain).toBeGreaterThan(IG_THRESHOLD);
    });

    it('should return higher gain for a more-evenly-split dimension vs a skewed dimension', () => {
      // topics: 4 distinct first-topics (max entropy) vs license: all same value (0 entropy).
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', topics: ['vector-database'], license: 'MIT' }),
        makeTool({ id: 'b', name: 'b', topics: ['graph-database'], license: 'MIT' }),
        makeTool({ id: 'c', name: 'c', topics: ['llm-framework'], license: 'MIT' }),
        makeTool({ id: 'd', name: 'd', topics: ['testing'], license: 'MIT' }),
      ];
      const result = calc.compute(tools);
      const topicsGain = result.get('topics') ?? 0;
      const licenseGain = result.get('license') ?? 0;
      expect(topicsGain).toBeGreaterThan(licenseGain);
    });

    it('should sort dimensions in descending order of information gain', () => {
      // topics is diverse, license is uniform — topics should appear before license in iteration.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', topics: ['vector-database'], license: 'MIT' }),
        makeTool({ id: 'b', name: 'b', topics: ['graph-database'], license: 'MIT' }),
        makeTool({ id: 'c', name: 'c', topics: ['llm-framework'], license: 'MIT' }),
      ];
      const result = calc.compute(tools);
      const entries = [...result.entries()];
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1]?.[1] ?? 0).toBeGreaterThanOrEqual(entries[i]?.[1] ?? 0);
      }
    });

    it('should correctly determine is_stable based on maintenance_score threshold (0.6)', () => {
      // One tool above threshold (stable), one below (emerging).
      // Entropy of [1,1] = 1 bit > 0.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'stable', name: 'stable', health: makeHealth(0.9) }),
        makeTool({ id: 'emerging', name: 'emerging', health: makeHealth(0.3) }),
      ];
      const result = calc.compute(tools);
      const isStableGain = result.get('is_stable') ?? 0;
      expect(isStableGain).toBeGreaterThan(0);
    });

    it('should return zero is_stable gain when all tools have the same stability', () => {
      // All tools have maintenance_score >= 0.6 → all 'stable' → entropy = 0.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', health: makeHealth(0.8) }),
        makeTool({ id: 'b', name: 'b', health: makeHealth(0.9) }),
        makeTool({ id: 'c', name: 'c', health: makeHealth(0.7) }),
      ];
      const result = calc.compute(tools);
      expect(result.get('is_stable')).toBe(0);
    });

    it('should handle deployment_model using only the first entry of deployment_models', () => {
      // Two tools: first has 'self-hosted', second has 'cloud'.
      // Entropy([1,1]) = 1 > 0.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', deployment_models: ['self-hosted'] }),
        makeTool({ id: 'b', name: 'b', deployment_models: ['cloud'] }),
      ];
      const result = calc.compute(tools);
      const deployGain = result.get('deployment_model') ?? 0;
      expect(deployGain).toBeGreaterThan(0);
    });

    it('should map to "unknown" for deployment_model when deployment_models is empty', () => {
      // All tools have empty deployment_models → all map to 'unknown' → entropy = 0.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({ id: 'a', name: 'a', deployment_models: [] }),
        makeTool({ id: 'b', name: 'b', deployment_models: [] }),
      ];
      const result = calc.compute(tools);
      expect(result.get('deployment_model')).toBe(0);
    });

    it('should compute exactly 1 bit of entropy for a perfectly balanced binary split', () => {
      // 2 tools, each with different values for every dimension: entropy = 1 bit each.
      const calc = new InformationGainCalculator();
      const tools = [
        makeTool({
          id: 'a',
          name: 'a',
          topics: ['vector-database'],
          license: 'MIT',
          language: 'TypeScript',
          deployment_models: ['cloud'],
          health: makeHealth(0.8),
        }),
        makeTool({
          id: 'b',
          name: 'b',
          topics: ['graph-database'],
          license: 'Apache-2.0',
          language: 'Go',
          deployment_models: ['self-hosted'],
          health: makeHealth(0.3),
        }),
      ];
      const result = calc.compute(tools);
      // Every dimension has exactly 2 distinct values → each should be 1 bit
      for (const [, score] of result) {
        expect(score).toBeCloseTo(1, 10);
      }
    });
  });
});

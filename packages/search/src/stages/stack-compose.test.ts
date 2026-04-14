import type { ToolNode } from '@toolcairn/core';
import type { PairwiseEdge } from '@toolcairn/graph';
import { describe, expect, it } from 'vitest';
import type { ToolScoredResult } from '../types.js';
import { composeStack } from './stack-compose.js';

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

function makeTool(name: string, category: string, topics: string[] = []): ToolNode {
  return {
    id: name,
    name,
    display_name: name,
    description: `A ${category} tool`,
    category,
    github_url: `https://github.com/example/${name}`,
    license: 'MIT',
    language: 'TypeScript',
    languages: ['TypeScript'],
    deployment_models: ['cloud'],
    package_managers: [],
    health: makeHealth(),
    docs: {},
    topics,
    is_fork: false,
    ecosystem_centrality: 0,
    pagerank_score: 0,
    search_weight: 1.0,
    is_canonical: false,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  };
}

function scored(
  name: string,
  score: number,
  category: string,
  topics: string[] = [],
): ToolScoredResult {
  return { tool: makeTool(name, category, topics), score };
}

function edge(
  source: string,
  target: string,
  edgeType: string,
  effectiveWeight = 0.5,
): PairwiseEdge {
  return { source, target, edgeType, effectiveWeight };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('composeStack', () => {
  it('returns empty stack for empty candidates', () => {
    const result = composeStack([], new Map(), [], 5);
    expect(result.tools).toHaveLength(0);
    expect(result.integrationNotes).toHaveLength(0);
  });

  it('returns single candidate with UseCase as role', () => {
    const candidates = [scored('logto', 0.9, 'authentication')];
    const useCases = new Map([['logto', ['authentication', 'sso', 'oauth2']]]);
    const result = composeStack(candidates, useCases, [], 5);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.role).toBe('Authentication');
  });

  it('picks diverse tools across UseCase groups — not 3 auth tools', () => {
    const candidates = [
      scored('logto', 0.9, 'authentication'),
      scored('authelia', 0.85, 'totp'),
      scored('zitadel', 0.8, 'saml'),
      scored('prisma', 0.7, 'orm'),
      scored('supabase', 0.65, 'database'),
    ];
    const useCases = new Map([
      ['logto', ['authentication', 'sso', 'oauth2', 'mfa']],
      ['authelia', ['authentication', 'sso', 'oauth2', 'mfa', 'totp']],
      ['zitadel', ['authentication', 'sso', 'oauth2', 'mfa', 'saml']],
      ['prisma', ['orm', 'database', 'postgresql', 'mysql']],
      ['supabase', ['database', 'realtime', 'auth', 'postgres']],
    ]);

    const result = composeStack(candidates, useCases, [], 3);

    const names = result.tools.map((t) => t.tool.name);
    // Should pick logto (highest auth), then prisma or supabase (new UseCases), NOT authelia/zitadel
    expect(names).toContain('logto');
    // At most 1 auth tool — authelia and zitadel overlap heavily with logto
    const authTools = names.filter((n) => ['logto', 'authelia', 'zitadel'].includes(n));
    expect(authTools.length).toBeLessThanOrEqual(1);
    // Should include a database/ORM tool
    const dbTools = names.filter((n) => ['prisma', 'supabase'].includes(n));
    expect(dbTools.length).toBeGreaterThanOrEqual(1);
  });

  it('applies DUPLICATE_PENALTY when all UseCases already covered', () => {
    const candidates = [
      scored('logto', 0.9, 'auth'),
      scored('authelia', 0.85, 'auth'),
      scored('lowscored-db', 0.4, 'database'),
    ];
    const useCases = new Map([
      ['logto', ['authentication', 'sso']],
      ['authelia', ['authentication', 'sso']], // exact same UseCases as logto
      ['lowscored-db', ['database', 'sql']], // completely new
    ]);

    const result = composeStack(candidates, useCases, [], 2);
    // lowscored-db brings new coverage despite lower score — should beat authelia
    expect(result.tools[0]?.tool.name).toBe('logto');
    expect(result.tools[1]?.tool.name).toBe('lowscored-db');
  });

  it('boosts tools with INTEGRATES_WITH edges to stack members', () => {
    const candidates = [
      scored('express', 0.9, 'web-framework'),
      scored('tool-a', 0.6, 'testing'),
      scored('tool-b', 0.6, 'testing'),
    ];
    const useCases = new Map([
      ['express', ['express', 'server']],
      ['tool-a', ['testing', 'unit']],
      ['tool-b', ['testing', 'e2e']],
    ]);
    // tool-a integrates with express, tool-b does not
    const edges = [edge('express', 'tool-a', 'INTEGRATES_WITH', 0.8)];

    const result = composeStack(candidates, useCases, edges, 2);
    expect(result.tools[0]?.tool.name).toBe('express');
    // tool-a should beat tool-b due to integration bonus
    expect(result.tools[1]?.tool.name).toBe('tool-a');
  });

  it('penalizes tools with REPLACES edges to stack members', () => {
    const candidates = [
      scored('express', 0.9, 'web-framework'),
      scored('fastify', 0.88, 'web-framework'),
      scored('prisma', 0.5, 'orm'),
    ];
    const useCases = new Map([
      ['express', ['express', 'server']],
      ['fastify', ['webframework', 'performance']], // different UseCases
      ['prisma', ['orm', 'database']],
    ]);
    // fastify REPLACES express — they're alternatives
    const edges = [edge('express', 'fastify', 'REPLACES', 0.8)];

    const result = composeStack(candidates, useCases, edges, 2);
    expect(result.tools[0]?.tool.name).toBe('express');
    // prisma should beat fastify despite lower score, because fastify has REPLACES penalty
    expect(result.tools[1]?.tool.name).toBe('prisma');
  });

  it('falls back to topics when SOLVES edges are missing', () => {
    const candidates = [
      scored('tool-a', 0.9, 'cat-a', ['auth', 'sso']),
      scored('tool-b', 0.8, 'cat-b', ['auth', 'sso']), // same topics
      scored('tool-c', 0.7, 'cat-c', ['database', 'sql']), // different topics
    ];
    // No SOLVES edges — empty useCases map
    const useCases = new Map<string, string[]>();

    const result = composeStack(candidates, useCases, [], 2);
    expect(result.tools[0]?.tool.name).toBe('tool-a');
    // tool-c brings new coverage via topics fallback
    expect(result.tools[1]?.tool.name).toBe('tool-c');
  });

  it('competes on pure relevance when no UseCase or topic data exists', () => {
    const candidates = [
      scored('tool-a', 0.9, 'other', []),
      scored('tool-b', 0.8, 'other', []),
      scored('tool-c', 0.7, 'other', []),
    ];
    const useCases = new Map<string, string[]>();

    const result = composeStack(candidates, useCases, [], 3);
    // No coverage data → pure relevance ordering
    expect(result.tools[0]?.tool.name).toBe('tool-a');
    expect(result.tools[1]?.tool.name).toBe('tool-b');
    expect(result.tools[2]?.tool.name).toBe('tool-c');
  });

  it('derives role from first new UseCase covered', () => {
    const candidates = [scored('logto', 0.9, 'authentication'), scored('prisma', 0.7, 'orm')];
    const useCases = new Map([
      ['logto', ['authentication', 'sso']],
      ['prisma', ['orm', 'database']],
    ]);

    const result = composeStack(candidates, useCases, [], 2);
    expect(result.tools[0]?.role).toBe('Authentication');
    expect(result.tools[1]?.role).toBe('Orm');
  });

  it('builds integration notes from INTEGRATES_WITH edges between stack members', () => {
    const candidates = [scored('prisma', 0.9, 'orm'), scored('postgresql', 0.7, 'database')];
    const useCases = new Map([
      ['prisma', ['orm', 'query-builder']],
      ['postgresql', ['database', 'sql']],
    ]);
    const edges = [edge('postgresql', 'prisma', 'INTEGRATES_WITH', 0.5)];

    const result = composeStack(candidates, useCases, edges, 2);
    expect(result.integrationNotes.length).toBeGreaterThan(0);
    expect(result.integrationNotes[0]).toContain('integrates with');
  });

  it('handles fewer candidates than limit gracefully', () => {
    const candidates = [scored('logto', 0.9, 'auth')];
    const useCases = new Map([['logto', ['authentication']]]);

    const result = composeStack(candidates, useCases, [], 5);
    expect(result.tools).toHaveLength(1);
  });

  it('uses facet provenance for role label when provided', () => {
    const candidates = [
      scored('logto', 0.9, 'authentication'),
      scored('postgresql', 0.7, 'postgresql'),
    ];
    const useCases = new Map([
      ['logto', ['authentication', 'sso']],
      ['postgresql', ['database', 'sql']],
    ]);
    const provenance = new Map([
      ['logto', 'authentication'],
      ['postgresql', 'database'],
    ]);

    const result = composeStack(candidates, useCases, [], 2, provenance);
    expect(result.tools[0]?.role).toBe('Authentication');
    expect(result.tools[1]?.role).toBe('Database');
  });

  it('falls back to UseCase when no facet provenance for a tool', () => {
    const candidates = [scored('logto', 0.9, 'authentication'), scored('prisma', 0.7, 'orm')];
    const useCases = new Map([
      ['logto', ['authentication', 'sso']],
      ['prisma', ['orm', 'database']],
    ]);
    // Only logto has provenance, prisma doesn't (came from backup search)
    const provenance = new Map([['logto', 'authentication']]);

    const result = composeStack(candidates, useCases, [], 2, provenance);
    expect(result.tools[0]?.role).toBe('Authentication'); // from provenance
    expect(result.tools[1]?.role).toBe('Orm'); // from UseCase fallback
  });
});

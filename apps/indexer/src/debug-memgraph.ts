import type { ToolNode } from '@toolcairn/core';
import { MemgraphToolRepository } from '@toolcairn/graph';

const repo = new MemgraphToolRepository();

const tool: ToolNode = {
  id: 'debug-uuid-001',
  name: 'zod-debug',
  display_name: 'zod',
  description: 'TypeScript-first schema declaration',
  category: 'other',
  github_url: 'https://github.com/colinhacks/zod',
  homepage_url: undefined,
  license: 'MIT',
  language: 'TypeScript',
  languages: ['TypeScript'],
  deployment_models: ['self-hosted'],
  package_managers: [
    { registry: 'npm', packageName: 'npm', installCommand: 'npm install npm', weeklyDownloads: 0 },
  ],
  health: {
    stars: 35000,
    stars_velocity_90d: 1750,
    last_commit_date: new Date().toISOString(),
    commit_velocity_30d: 10,
    open_issues: 500,
    closed_issues_30d: 100,
    pr_response_time_hours: 48,
    contributor_count: 100,
    contributor_trend: 0,
    last_release_date: new Date().toISOString(),
    maintenance_score: 0.75,
    credibility_score: 0.8,
    forks_count: 0,
    stars_snapshot_at: '',
    stars_velocity_7d: 0,
    stars_velocity_30d: 0,
  },
  docs: { readme_url: 'https://github.com/colinhacks/zod/blob/main/README.md' },
  topics: [],
  is_fork: false,
  ecosystem_centrality: 0,
  pagerank_score: 0,
  search_weight: 1.0,
  is_canonical: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const result = await repo.createTool(tool);
if (result.ok) {
} else {
  console.error('FAILED:', JSON.stringify(result.error, null, 2));
}
process.exit(0);

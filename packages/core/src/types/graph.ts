// ToolPilot Graph Node & Edge Type Definitions
// These are the canonical TypeScript types for all Memgraph nodes and edges.

// ─── Enums & Unions ────────────────────────────────────────────────────────

export type ToolCategory = string;

export type DeploymentModel = 'self-hosted' | 'cloud' | 'embedded' | 'serverless';

export type EdgeSource =
  | 'usage_data'
  | 'ai_generated'
  | 'github_signal'
  | 'manual'
  | 'co_occurrence'
  | 'changelog'
  | 'declared_dependency'
  | 'vector_similarity';

export type EdgeType =
  | 'SOLVES'
  | 'FOLLOWS'
  | 'BELONGS_TO'
  | 'REQUIRES'
  | 'INTEGRATES_WITH'
  | 'REPLACES'
  | 'CONFLICTS_WITH'
  | 'POPULAR_WITH'
  | 'BREAKS_FROM'
  | 'HAS_VERSION'
  | 'COMPATIBLE_WITH'
  | 'CO_OCCURS_WITH';

export type NodeType = 'Tool' | 'UseCase' | 'Stack' | 'Pattern' | 'Requirement' | 'Version';

// ─── Health Signals ────────────────────────────────────────────────────────

export interface HealthSignals {
  /** Total GitHub stars */
  stars: number;
  /** Stars gained in last 90 days */
  stars_velocity_90d: number;
  /** ISO date of last commit */
  last_commit_date: string;
  /** Commits in last 30 days */
  commit_velocity_30d: number;
  /** Count of open issues */
  open_issues: number;
  /** Issues closed in last 30 days */
  closed_issues_30d: number;
  /** Median hours for first PR response */
  pr_response_time_hours: number;
  /** Total contributors */
  contributor_count: number;
  /** Change in contributors over last 90 days (can be negative) */
  contributor_trend: number;
  /** ISO date of last release */
  last_release_date: string;
  /**
   * Composite score 0–1 computed as:
   * 0.25 * commit_recency + 0.20 * stars_velocity + 0.20 * issue_resolution_rate
   * + 0.15 * pr_response_score + 0.10 * contributor_trend + 0.10 * release_recency
   */
  maintenance_score: number;
  /**
   * Composite credibility score 0–1 blending popularity, trust, and activity.
   * Updated formula: 0.28*log_stars + 0.18*forks_score + 0.15*org_bonus
   *   + 0.15*maintenance + 0.12*downloads + 0.07*contributors + 0.05*velocity_30d
   * Multiplied by 0.4 if the tool is itself a fork (is_fork = true).
   */
  credibility_score: number;
  /** GitHub forks_count — how many times others have forked this tool */
  forks_count: number;
  /** ISO date when stars were last snapshotted for velocity computation */
  stars_snapshot_at: string;
  /** Stars gained in last 7 days (computed from snapshots) */
  stars_velocity_7d: number;
  /** Stars gained in last 30 days (computed from snapshots) */
  stars_velocity_30d: number;
}

export interface DocumentationLinks {
  readme_url?: string;
  docs_url?: string;
  api_url?: string;
  changelog_url?: string;
}

/** A package distribution channel for a tool */
export interface PackageChannel {
  registry: string; // e.g. 'npm', 'pypi', 'crates', 'homebrew', 'docker'
  packageName: string; // e.g. 'express', 'flask', 'ripgrep'
  installCommand: string; // e.g. 'npm install express', 'pip install flask'
  weeklyDownloads: number; // weekly equivalent at last index time, 0 if unavailable
}

// ─── Node Types ────────────────────────────────────────────────────────────

export interface ToolNode {
  id: string;
  name: string;
  display_name: string;
  description: string;
  category: ToolCategory;
  github_url: string;
  homepage_url?: string;
  owner_name?: string;
  owner_type?: 'User' | 'Organization';
  license: string;
  language: string;
  languages: string[];
  deployment_models: DeploymentModel[];
  /** Distribution channels this tool is published to */
  package_managers: PackageChannel[];
  health: HealthSignals;
  docs: DocumentationLinks;
  /** GitHub topics / npm keywords — community-curated tags, persisted for graph mesh */
  topics: string[];
  /** True if this repo is a fork of another repo — carries a credibility penalty */
  is_fork: boolean;
  /**
   * Inbound edge count — how many other tools have edges pointing TO this tool.
   * Set by compute-centrality.ts script. Never overwritten on re-index.
   */
  ecosystem_centrality: number;
  /**
   * Normalized PageRank score 0–1 from the tool graph.
   * Set by compute-pagerank.ts weekly. Never overwritten on re-index.
   */
  pagerank_score: number;
  /**
   * Feedback-loop search weight multiplier (default 1.0, max 2.0).
   * Incremented by update-search-weights.ts when users report success.
   * Never overwritten on re-index.
   */
  search_weight: number;
  /**
   * Curated canonical flag — tool is definitively the primary tool for its name.
   * Set by set-canonical-tools.ts. Never overwritten on re-index.
   * Canonical tools bypass the Stage 0 credibility gate.
   */
  is_canonical: boolean;
  /**
   * Grace period for personal repos (500-999 stars).
   * ISO date when current grace window expires. Null = not in grace period.
   * Set by cleanup script only — never overwritten by reindex.
   */
  grace_until?: string;
  /**
   * How many 1-week grace extensions have been given (max 4 = ~1 month total).
   * After 4 retries still under 1k stars → tool is removed.
   */
  grace_retries?: number;
  created_at: string;
  updated_at: string;
}

export interface UseCaseNode {
  id: string;
  name: string;
  description: string;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface StackNode {
  id: string;
  name: string;
  description: string;
  /** IDs of tools in this stack */
  tool_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface PatternNode {
  id: string;
  name: string;
  description: string;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface RequirementNode {
  id: string;
  name: string;
  type: 'constraint' | 'preference';
  description: string;
  created_at: string;
  updated_at: string;
}

export interface BreakingChange {
  type: string;
  target: string;
  version: string;
  description: string;
}

export interface VersionNode {
  id: string;
  tool_id: string;
  version: string;
  release_date: string;
  is_stable: boolean;
  is_latest: boolean;
  breaking_changes: BreakingChange[];
  created_at: string;
}

// ─── Edge Types ────────────────────────────────────────────────────────────

export interface EdgeProperties {
  /** Base weight 0–1, before temporal decay */
  weight: number;
  /** Confidence in the relationship 0–1 */
  confidence: number;
  /** ISO timestamp of last verification */
  last_verified: string;
  source: EdgeSource;
  /**
   * Decay rate for temporal weight computation.
   * effective_weight = weight × exp(-decay_rate × days_since_verified)
   * Default: 0.05
   */
  decay_rate: number;
  evidence_count?: number;
  evidence_links?: string[];
}

export interface GraphEdge {
  type: EdgeType;
  source_id: string;
  target_id: string;
  properties: EdgeProperties;
}

// ─── Union Types ───────────────────────────────────────────────────────────

export type AnyNode =
  | ToolNode
  | UseCaseNode
  | StackNode
  | PatternNode
  | RequirementNode
  | VersionNode;

export interface GraphNode {
  id: string;
  type: NodeType;
  properties: AnyNode;
}

// ─── Result Pattern ────────────────────────────────────────────────────────

export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error });

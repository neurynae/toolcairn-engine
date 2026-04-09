import type { HealthSignals } from './types/graph.js';

export interface QualityScore {
  /** Overall score 0–100 */
  overall: number;
  /** Commit recency + release recency (35%) */
  maintenance: number;
  /** Stars + stars velocity (25%) */
  popularity: number;
  /** Commit velocity + issue resolution (25%) */
  activity: number;
  /** Contributor count (15%) */
  community: number;
}

function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

function recencyScore(dateStr: string): number {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 0;
  const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 365);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Decompose a ToolNode's HealthSignals into a QualityScore breakdown (0–100 per dimension).
 * The overall score is a weighted average of the four dimensions.
 */
export function computeQualityBreakdown(health: HealthSignals): QualityScore {
  // Maintenance (35%): commit recency + release recency
  const commitRecency = recencyScore(health.last_commit_date);
  const releaseRecency = recencyScore(health.last_release_date);
  const maintenance = clamp(commitRecency * 0.6 + releaseRecency * 0.4);

  // Popularity (25%): stars (log-normalised to 50k) + velocity (log-normalised to 1000)
  const starsScore = normalizeLog(health.stars, 50_000);
  const velocityScore = normalizeLog(health.stars_velocity_90d, 1_000);
  const popularity = clamp(starsScore * 0.6 + velocityScore * 0.4);

  // Activity (25%): commit velocity + issue resolution rate
  const commitVelocityScore = normalizeLog(health.commit_velocity_30d, 30);
  const total = health.open_issues + health.closed_issues_30d;
  const issueResolution = total > 0 ? health.closed_issues_30d / total : 0.5;
  const activity = clamp(commitVelocityScore * 0.5 + issueResolution * 0.5);

  // Community (15%): contributor count (log-normalised to 500)
  const community = clamp(normalizeLog(health.contributor_count, 500));

  const overall = clamp(
    maintenance * 0.35 + popularity * 0.25 + activity * 0.25 + community * 0.15,
  );

  return {
    overall: Math.round(overall * 100),
    maintenance: Math.round(maintenance * 100),
    popularity: Math.round(popularity * 100),
    activity: Math.round(activity * 100),
    community: Math.round(community * 100),
  };
}

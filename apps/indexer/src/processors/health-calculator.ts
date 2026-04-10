import type { HealthSignals } from '@toolcairn/core';

interface GitHubRepoData {
  stargazers_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  updated_at?: string;
  subscribers_count?: number;
}

interface RawGitHubData {
  repo?: GitHubRepoData;
  topics?: string[];
}

function extractNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Normalize a raw value to a 0–1 score using soft max.
 * Uses a logarithmic scale so extreme values don't dominate.
 */
function normalizeLog(value: number, scale: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(scale));
}

/**
 * Given a date string, compute a recency score 0–1 where:
 * - today = 1.0
 * - 1 year ago = 0.5
 * - 2 years ago = ~0.25
 */
function recencyScore(dateStr: string): number {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 0;
  const now = Date.now();
  const ageMs = now - date.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Half-life of 365 days
  return Math.exp(-ageDays / 365);
}

/**
 * Calculate HealthSignals from a raw GitHub API response.
 *
 * @param raw - Raw crawler response
 * @param prev - Previous health snapshot from the last index run (for real velocity)
 * @param ownerType - 'User' or 'Organization' — used for credibility scoring
 */
export function calculateHealth(
  raw: unknown,
  prev?: { stars: number; updatedAt: string },
  ownerType?: 'User' | 'Organization',
): HealthSignals {
  const data = raw as RawGitHubData;
  const repo: GitHubRepoData =
    typeof data === 'object' && data !== null && 'repo' in data ? (data.repo ?? {}) : {};

  const stars = extractNumber(repo.stargazers_count);
  const openIssues = extractNumber(repo.open_issues_count);
  const lastCommitDate = extractString(repo.pushed_at) || new Date().toISOString();
  const lastReleaseDate = extractString(repo.updated_at) || new Date().toISOString();
  const contributorCount = extractNumber(repo.subscribers_count);

  // Real stars_velocity_90d: if we have a previous snapshot, compute from actual delta.
  // Falls back to the 5% estimate only on the very first index of a tool.
  let starsVelocity90d: number;
  if (prev && prev.stars >= 0) {
    const prevDate = new Date(prev.updatedAt);
    const daysElapsed = Math.max(1, (Date.now() - prevDate.getTime()) / 86_400_000);
    const delta = Math.max(0, stars - prev.stars);
    starsVelocity90d = Math.round((delta / daysElapsed) * 90);
  } else {
    starsVelocity90d = Math.round(stars * 0.05); // first-index estimate
  }
  const commitVelocity30d =
    recencyScore(lastCommitDate) > 0.8 ? 10 : recencyScore(lastCommitDate) > 0.5 ? 3 : 1;
  const closedIssues30d = Math.round(openIssues * 0.2);
  const prResponseTimeHours = 48; // default conservative estimate
  const contributorTrend = 0; // unknown without contributor history API

  // Composite maintenance_score components
  const commitRecency = recencyScore(lastCommitDate);
  const starsVelocityScore = normalizeLog(starsVelocity90d, 1000);
  const issueResolutionRate =
    openIssues > 0 ? Math.min(1, closedIssues30d / (openIssues + closedIssues30d)) : 0.5;
  const prResponseScore = Math.max(0, 1 - prResponseTimeHours / (24 * 14));
  const contributorTrendScore = 0.5; // neutral
  const releaseRecency = recencyScore(lastReleaseDate);

  const maintenanceScore =
    0.25 * commitRecency +
    0.2 * starsVelocityScore +
    0.2 * issueResolutionRate +
    0.15 * prResponseScore +
    0.1 * contributorTrendScore +
    0.1 * releaseRecency;

  // Credibility: composite trust signal for search ranking.
  // Blends popularity (stars), trust (org vs personal), activity, and resilience.
  const logStars = Math.min(1, Math.log10(stars + 1) / Math.log10(300_001));
  const orgBonus = ownerType === 'Organization' ? 1.0 : stars >= 1000 ? 0.6 : 0.3;
  const contribScore = normalizeLog(contributorCount, 500);
  const velocityScore = normalizeLog(starsVelocity90d, 5000);

  const credibilityScore =
    0.35 * logStars +
    0.2 * orgBonus +
    0.2 * Math.max(0, Math.min(1, maintenanceScore)) +
    0.15 * contribScore +
    0.1 * velocityScore;

  return {
    stars,
    stars_velocity_90d: starsVelocity90d,
    last_commit_date: lastCommitDate,
    commit_velocity_30d: commitVelocity30d,
    open_issues: openIssues,
    closed_issues_30d: closedIssues30d,
    pr_response_time_hours: prResponseTimeHours,
    contributor_count: contributorCount,
    contributor_trend: contributorTrend,
    last_release_date: lastReleaseDate,
    maintenance_score: Math.max(0, Math.min(1, maintenanceScore)),
    credibility_score: Math.max(0, Math.min(1, credibilityScore)),
  };
}

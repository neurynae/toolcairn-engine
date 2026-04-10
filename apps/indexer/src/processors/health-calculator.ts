import type { HealthSignals } from '@toolcairn/core';

interface GitHubRepoData {
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  updated_at?: string;
  subscribers_count?: number;
}

interface RawGitHubData {
  repo?: GitHubRepoData;
  topics?: string[];
  weekly_downloads?: number;
}

function extractNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

/**
 * Calculate HealthSignals from a raw GitHub API response.
 *
 * @param raw - Raw crawler response (includes weekly_downloads if set by crawlers)
 * @param prev - Previous health snapshot for real velocity computation
 * @param ownerType - 'User' or 'Organization'
 * @param isFork - true if this repo is itself a fork of another repo
 */
export function calculateHealth(
  raw: unknown,
  prev?: { stars: number; updatedAt: string },
  ownerType?: 'User' | 'Organization',
  isFork?: boolean,
): HealthSignals {
  const data = raw as RawGitHubData;
  const repo: GitHubRepoData =
    typeof data === 'object' && data !== null && 'repo' in data ? (data.repo ?? {}) : {};

  const stars = extractNumber(repo.stargazers_count);
  const forksCount = extractNumber(repo.forks_count);
  const openIssues = extractNumber(repo.open_issues_count);
  const lastCommitDate = extractString(repo.pushed_at) || new Date().toISOString();
  const lastReleaseDate = extractString(repo.updated_at) || new Date().toISOString();
  const contributorCount = extractNumber(repo.subscribers_count);
  const weeklyDownloads = extractNumber(data?.weekly_downloads);

  // Real velocity from snapshot delta
  let starsVelocity90d: number;
  let starsVelocity30d: number;
  let starsVelocity7d: number;
  let starsSnapshotAt: string;

  if (prev && prev.stars >= 0) {
    const prevDate = new Date(prev.updatedAt);
    const daysElapsed = Math.max(1, (Date.now() - prevDate.getTime()) / 86_400_000);
    const delta = Math.max(0, stars - prev.stars);
    starsVelocity90d = Math.round((delta / daysElapsed) * 90);
    starsVelocity30d = Math.round((delta / daysElapsed) * 30);
    starsVelocity7d = Math.round((delta / daysElapsed) * 7);
    starsSnapshotAt = new Date().toISOString();
  } else {
    starsVelocity90d = Math.round(stars * 0.05); // first-index estimate
    starsVelocity30d = Math.round(stars * 0.015);
    starsVelocity7d = Math.round(stars * 0.003);
    starsSnapshotAt = new Date().toISOString();
  }

  const commitVelocity30d =
    recencyScore(lastCommitDate) > 0.8 ? 10 : recencyScore(lastCommitDate) > 0.5 ? 3 : 1;
  const closedIssues30d = Math.round(openIssues * 0.2);
  const prResponseTimeHours = 48;
  const contributorTrend = 0;

  const commitRecency = recencyScore(lastCommitDate);
  const starsVelocityScore = normalizeLog(starsVelocity90d, 1000);
  const issueResolutionRate =
    openIssues > 0 ? Math.min(1, closedIssues30d / (openIssues + closedIssues30d)) : 0.5;
  const prResponseScore = Math.max(0, 1 - prResponseTimeHours / (24 * 14));
  const contributorTrendScore = 0.5;
  const releaseRecency = recencyScore(lastReleaseDate);

  const maintenanceScore =
    0.25 * commitRecency +
    0.2 * starsVelocityScore +
    0.2 * issueResolutionRate +
    0.15 * prResponseScore +
    0.1 * contributorTrendScore +
    0.1 * releaseRecency;

  // ── Credibility formula ───────────────────────────────────────────────────
  // Weights: stars 0.28, forks 0.18, org 0.15, maintenance 0.15,
  //          downloads 0.12, contributors 0.07, velocity_30d 0.05 = 1.00
  const logStars = Math.min(1, Math.log10(stars + 1) / Math.log10(300_001));
  const forksScore = Math.min(1, Math.log10(forksCount + 1) / Math.log10(100_001));
  const orgBonus = ownerType === 'Organization' ? 1.0 : stars >= 1000 ? 0.6 : 0.3;
  const contribScore = normalizeLog(contributorCount, 500);
  const dlScore = normalizeLog(weeklyDownloads, 500_000);
  const velocity30dScore = normalizeLog(starsVelocity30d, 5000);

  const rawCredibility =
    0.28 * logStars +
    0.18 * forksScore +
    0.15 * orgBonus +
    0.15 * Math.max(0, Math.min(1, maintenanceScore)) +
    0.12 * dlScore +
    0.07 * contribScore +
    0.05 * velocity30dScore;

  // Forks of another repo get a 40% credibility penalty
  const forkPenalty = isFork ? 0.4 : 1.0;
  const credibilityScore = Math.max(0, Math.min(1, rawCredibility * forkPenalty));

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
    credibility_score: credibilityScore,
    forks_count: forksCount,
    weekly_downloads: weeklyDownloads,
    stars_snapshot_at: starsSnapshotAt,
    stars_velocity_7d: starsVelocity7d,
    stars_velocity_30d: starsVelocity30d,
  };
}

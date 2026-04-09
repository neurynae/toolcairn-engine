/**
 * Deprecation Detector — runs after each tool is indexed.
 *
 * Checks health signals for signs the tool is deprecated or abandoned.
 * Returns a structured result used to create DeprecationAlert records.
 */

import type { HealthSignals } from '@toolcairn/core';

export interface DeprecationResult {
  isDeprecated: boolean;
  reason: 'npm_deprecated' | 'repo_archived' | 'stale_commits' | 'open_issues' | null;
  severity: 'warning' | 'critical' | null;
  details: string;
}

const STALE_MONTHS = 18;
const STALE_MS = STALE_MONTHS * 30 * 24 * 60 * 60 * 1000;
const LOW_HEALTH_THRESHOLD = 0.25;
const HIGH_ISSUES_THRESHOLD = 500;

export function detectDeprecation(
  health: HealthSignals,
  raw?: { archived?: boolean; deprecated?: string | boolean | null },
): DeprecationResult {
  // 1. GitHub repo explicitly archived → critical
  if (raw?.archived) {
    return {
      isDeprecated: true,
      reason: 'repo_archived',
      severity: 'critical',
      details: 'The GitHub repository has been archived by its owner.',
    };
  }

  // 2. npm `deprecated` field → critical
  if (raw?.deprecated) {
    return {
      isDeprecated: true,
      reason: 'npm_deprecated',
      severity: 'critical',
      details:
        typeof raw.deprecated === 'string'
          ? raw.deprecated
          : 'Package is marked deprecated on npm.',
    };
  }

  // 3. No commits for 18+ months AND low maintenance score → warning
  if (health.last_commit_date) {
    const lastCommit = new Date(health.last_commit_date).getTime();
    const stale = Date.now() - lastCommit > STALE_MS;
    if (stale && health.maintenance_score < LOW_HEALTH_THRESHOLD) {
      return {
        isDeprecated: true,
        reason: 'stale_commits',
        severity: 'warning',
        details: `No commits in ${STALE_MONTHS}+ months and maintenance score is critically low (${Math.round(health.maintenance_score * 100)}%).`,
      };
    }
  }

  // 4. Very high open issues with zero recent closes → warning
  if (health.open_issues > HIGH_ISSUES_THRESHOLD && health.closed_issues_30d === 0) {
    return {
      isDeprecated: true,
      reason: 'open_issues',
      severity: 'warning',
      details: `${health.open_issues.toLocaleString()} open issues with no recent activity.`,
    };
  }

  return { isDeprecated: false, reason: null, severity: null, details: '' };
}

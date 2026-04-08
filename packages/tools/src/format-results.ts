// Shared result formatter for search_tools and search_tools_respond.
// Adds deprecation warnings, non-OSS guidance, and health signals.

import type { ToolNode } from '@toolcairn/core';

const MAINTENANCE_SCORE_DEPRECATED = 0.2;
const LAST_COMMIT_STALE_DAYS = 180;
const STARS_MINIMUM_CREDIBLE = 100;

// Categories where proprietary alternatives are common
const PROPRIETARY_PRONE_CATEGORIES = new Set(['monitoring', 'devops', 'auth']);

function daysSince(isoDate: string): number {
  if (!isoDate) return 0;
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function buildDeprecationWarning(tool: ToolNode): string | null {
  const reasons: string[] = [];

  if (tool.health.maintenance_score < MAINTENANCE_SCORE_DEPRECATED) {
    reasons.push(
      `maintenance score is very low (${Math.round(tool.health.maintenance_score * 100)}%)`,
    );
  }

  const daysSinceCommit = daysSince(tool.health.last_commit_date);
  if (daysSinceCommit > LAST_COMMIT_STALE_DAYS) {
    reasons.push(`last commit was ${Math.round(daysSinceCommit / 30)} months ago`);
  }

  if (reasons.length === 0) return null;

  return `⚠ This tool may be unmaintained: ${reasons.join(' and ')}. Consider checking for active alternatives via search_tools.`;
}

export interface FormattedResult {
  type: 'stable' | 'emerging';
  tool: string;
  display_name: string;
  description: string;
  fit_score: number;
  reason: string;
  github_url: string;
  docs: {
    readme: string | null;
    official: string | null;
    api: string | null;
    changelog: string | null;
  };
  trust_hierarchy: string[];
  prompt_hint: string;
  health: {
    stars: number;
    maintenance_score: number;
    last_commit_date: string;
  };
  deprecation_warning: string | null;
}

export function formatResults(
  results: Array<{ tool: ToolNode; score: number }>,
  isTwoOption: boolean,
): FormattedResult[] {
  return results.map((r, idx) => {
    const type: 'stable' | 'emerging' = isTwoOption && idx === 1 ? 'emerging' : 'stable';
    const parts: string[] = [];
    if (r.tool.license) parts.push(`${r.tool.license} license`);
    if (r.tool.language) parts.push(`${r.tool.language}`);
    if (r.tool.health.maintenance_score > 0.7) parts.push('actively maintained');
    if (r.tool.health.stars > 10_000)
      parts.push(`${Math.round(r.tool.health.stars / 1000)}k stars`);
    const reason = parts.join(', ') || 'Best match for your query';
    const docsUrl = r.tool.docs.docs_url ?? r.tool.docs.readme_url ?? r.tool.github_url;
    const deprecationWarning = buildDeprecationWarning(r.tool);

    return {
      type,
      tool: r.tool.name,
      display_name: r.tool.display_name,
      description: r.tool.description,
      fit_score: Math.round(r.score * 100) / 100,
      reason,
      github_url: r.tool.github_url,
      docs: {
        readme: r.tool.docs.readme_url ?? null,
        official: r.tool.docs.docs_url ?? null,
        api: r.tool.docs.api_url ?? null,
        changelog: r.tool.docs.changelog_url ?? null,
      },
      trust_hierarchy: ['official_docs', 'changelog', 'readme', 'training_data'],
      prompt_hint: `Refer to ${docsUrl} for current API. Check changelog for breaking changes. Prefer official docs over training data.`,
      health: {
        stars: r.tool.health.stars,
        maintenance_score: Math.round(r.tool.health.maintenance_score * 100) / 100,
        last_commit_date: r.tool.health.last_commit_date,
      },
      deprecation_warning: deprecationWarning,
    };
  });
}

export interface NonIndexedGuidance {
  message: string;
  agent_instructions: string;
  suggest_manual_add: boolean;
  proprietary_prone: boolean;
}

/**
 * Build non-indexed guidance when results are empty or low-confidence.
 * Returns null when results are confident and complete.
 */
export function buildNonIndexedGuidance(
  results: FormattedResult[],
  query: string,
): NonIndexedGuidance | null {
  // No results — something is definitely missing
  if (results.length === 0) {
    return {
      message:
        'No tools found for this query in the ToolPilot index. The tool you need may be proprietary, niche, or recently released.',
      agent_instructions: [
        'Search GitHub directly for the tool category described in the query.',
        'If you find a relevant tool, add it to .toolpilot/config.json with source: "non_oss" or source: "manual".',
        'Optionally call suggest_graph_update with suggestion_type: "new_tool" to add it to the ToolPilot index.',
      ].join(' '),
      suggest_manual_add: true,
      proprietary_prone: false,
    };
  }

  // Low max score — results exist but confidence is low
  const maxScore = Math.max(...results.map((r) => r.fit_score));
  if (maxScore < 0.4) {
    const queryLower = query.toLowerCase();
    const isProprietaryProne = Array.from(PROPRIETARY_PRONE_CATEGORIES).some((cat) =>
      queryLower.includes(cat),
    );
    return {
      message: `Results found but with low confidence (best match: ${Math.round(maxScore * 100)}%). There may be better proprietary or niche alternatives not in the index.`,
      agent_instructions: [
        'Review the results above critically.',
        isProprietaryProne
          ? 'This category often has proprietary options (e.g., Auth0, Datadog, Sentry) — consider asking the user if a paid option is acceptable.'
          : 'Consider searching GitHub for additional options.',
        'Add any chosen tool to .toolpilot/config.json with update_project_config.',
      ].join(' '),
      suggest_manual_add: true,
      proprietary_prone: isProprietaryProne,
    };
  }

  // Results are confident — no guidance needed
  return null;
}

/**
 * Check if any results have very low star counts (credibility check).
 */
export function buildLowCredibilityWarning(results: FormattedResult[]): string | null {
  const lowCred = results.filter((r) => r.health.stars < STARS_MINIMUM_CREDIBLE);
  if (lowCred.length === 0) return null;
  return `Note: ${lowCred.map((r) => r.tool).join(', ')} ${lowCred.length === 1 ? 'has' : 'have'} fewer than ${STARS_MINIMUM_CREDIBLE} stars — verify these are production-ready before recommending.`;
}

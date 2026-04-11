import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { ToolDeps } from '../types.js';
import { errResult, okResult, resolveToolName } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:compare-tools' });

const POSITIVE_EDGE_TYPES = new Set(['COMPATIBLE_WITH', 'INTEGRATES_WITH', 'POPULAR_WITH']);
const NEGATIVE_EDGE_TYPES = new Set(['CONFLICTS_WITH', 'BREAKS_FROM']);
const SUPERCESSION_TYPES = new Set(['REPLACES']);

interface ToolComparison {
  name: string;
  display_name: string;
  description: string;
  github_url: string;
  health: {
    stars: number;
    maintenance_score: number;
    last_commit_date: string;
    open_issues: number;
    contributor_count: number;
  };
  fit_score?: number;
}

function buildComparison(tool: ToolNode, useCase?: string): ToolComparison {
  return {
    name: tool.name,
    display_name: tool.display_name,
    description: tool.description,
    github_url: tool.github_url,
    health: {
      stars: tool.health.stars,
      maintenance_score: Math.round(tool.health.maintenance_score * 100) / 100,
      last_commit_date: tool.health.last_commit_date,
      open_issues: tool.health.open_issues,
      contributor_count: tool.health.contributor_count,
    },
    fit_score: useCase ? Math.round(tool.health.maintenance_score * 100) / 100 : undefined,
  };
}

function computeRecommendation(
  toolA: ToolNode,
  toolB: ToolNode,
  edgeTypes: string[],
): 'tool_a' | 'tool_b' | 'either' {
  const aReplacesB = edgeTypes.some((e) => e === 'REPLACES');
  if (aReplacesB) return 'tool_b';
  const scoreDiff = toolA.health.maintenance_score - toolB.health.maintenance_score;
  const starsDiff = toolA.health.stars - toolB.health.stars;
  if (Math.abs(scoreDiff) < 0.1 && Math.abs(starsDiff) < 5000) return 'either';
  if (scoreDiff > 0) return 'tool_a';
  if (scoreDiff < 0) return 'tool_b';
  return starsDiff >= 0 ? 'tool_a' : 'tool_b';
}

export function createCompareToolsHandler(deps: Pick<ToolDeps, 'graphRepo' | 'enqueueIndexJob'>) {
  return async function handleCompareTools(args: {
    tool_a: string;
    tool_b: string;
    use_case?: string;
    project_config?: string;
  }) {
    try {
      logger.info({ tool_a: args.tool_a, tool_b: args.tool_b }, 'compare_tools called');

      // Fuzzy-resolve names so "nextjs" → "next.js", "mcpserver" → "mcp-server", etc.
      const [nameA, nameB] = await Promise.all([
        resolveToolName(args.tool_a, deps.graphRepo),
        resolveToolName(args.tool_b, deps.graphRepo),
      ]);
      if (nameA !== args.tool_a)
        logger.info({ original: args.tool_a, resolved: nameA }, 'tool_a name resolved');
      if (nameB !== args.tool_b)
        logger.info({ original: args.tool_b, resolved: nameB }, 'tool_b name resolved');

      const [resultA, resultB] = await Promise.all([
        deps.graphRepo.findByName(nameA),
        deps.graphRepo.findByName(nameB),
      ]);

      const toolAFound = resultA.ok && resultA.data != null;
      const toolBFound = resultB.ok && resultB.data != null;

      if (!toolAFound && !toolBFound) {
        await Promise.allSettled([deps.enqueueIndexJob(nameA, 2), deps.enqueueIndexJob(nameB, 2)]);
        return okResult({
          status: 'not_indexed',
          tool_a: nameA,
          tool_b: nameB,
          async_index_triggered: true,
          agent_instructions: [
            `Neither "${nameA}" nor "${nameB}" is in the ToolCairn index.`,
            'Indexing has been triggered for both — results will be available in ~2 minutes.',
            'In the meantime, search GitHub for both tools to gather basic information for comparison.',
            'Use search_tools to find alternatives if these tools are not found.',
          ].join(' '),
        });
      }

      if (!toolAFound || !toolBFound) {
        const missingName = !toolAFound ? nameA : nameB;
        const indexedData = toolAFound
          ? resultA.ok
            ? resultA.data
            : null
          : resultB.ok
            ? resultB.data
            : null;
        const indexedTool = indexedData as ToolNode;
        await deps.enqueueIndexJob(missingName, 2);
        return okResult({
          status: 'partial',
          indexed_tool: buildComparison(indexedTool, args.use_case),
          unindexed_tool: {
            name: missingName,
            status: 'not_in_index',
            message: `"${missingName}" is not in the ToolCairn index yet.`,
          },
          async_index_triggered: true,
          agent_instructions: [
            `"${missingName}" is not indexed. Indexing has been triggered — retry compare_tools in ~2 minutes.`,
            `Meanwhile, "${indexedTool.name}" data is available above.`,
            `Search GitHub for "${missingName}" to gather basic health information for a manual comparison.`,
          ].join(' '),
        });
      }

      const toolA = resultA.data as ToolNode;
      const toolB = resultB.data as ToolNode;
      const edgesResult = await deps.graphRepo.getDirectEdges(nameA, nameB);
      const edges = edgesResult.ok ? edgesResult.data : [];

      const compatibilitySignal = edges.some((e) => POSITIVE_EDGE_TYPES.has(e.edgeType))
        ? 'compatible'
        : edges.some((e) => NEGATIVE_EDGE_TYPES.has(e.edgeType))
          ? 'conflicts'
          : edges.some((e) => SUPERCESSION_TYPES.has(e.edgeType))
            ? 'one_replaces_other'
            : 'unknown';

      const recommendation = computeRecommendation(
        toolA,
        toolB,
        edges.map((e) => e.edgeType),
      );

      const comparisonDimensions = [
        {
          dimension: 'Maintenance',
          tool_a: toolA.health.maintenance_score,
          tool_b: toolB.health.maintenance_score,
          winner: toolA.health.maintenance_score >= toolB.health.maintenance_score ? nameA : nameB,
          note: 'Composite score across commits, stars velocity, issue resolution, PR response',
        },
        {
          dimension: 'Community',
          tool_a: toolA.health.stars,
          tool_b: toolB.health.stars,
          winner: toolA.health.stars >= toolB.health.stars ? nameA : nameB,
          note: 'GitHub stars',
        },
        {
          dimension: 'Activity',
          tool_a: toolA.health.commit_velocity_30d ?? 0,
          tool_b: toolB.health.commit_velocity_30d ?? 0,
          winner:
            (toolA.health.commit_velocity_30d ?? 0) >= (toolB.health.commit_velocity_30d ?? 0)
              ? nameA
              : nameB,
          note: 'Commits in last 30 days',
        },
        {
          dimension: 'Contributors',
          tool_a: toolA.health.contributor_count,
          tool_b: toolB.health.contributor_count,
          winner: toolA.health.contributor_count >= toolB.health.contributor_count ? nameA : nameB,
          note: 'Total contributor count',
        },
      ];

      const winnerCounts = comparisonDimensions.reduce<Record<string, number>>((acc, d) => {
        acc[d.winner] = (acc[d.winner] ?? 0) + 1;
        return acc;
      }, {});
      const dominantWinner =
        Object.entries(winnerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'either';

      return okResult({
        status: 'complete',
        tool_a: buildComparison(toolA, args.use_case),
        tool_b: buildComparison(toolB, args.use_case),
        graph_relationship: {
          edges: edges.map((e) => ({
            type: e.edgeType,
            direction: e.direction,
            confidence: Math.round(e.confidence * 100) / 100,
            effective_weight: Math.round(e.effective_weight * 100) / 100,
          })),
          compatibility_signal: compatibilitySignal,
        },
        dimensions: comparisonDimensions,
        recommendation,
        dominant_winner: dominantWinner,
        confidence: edges.length > 0 ? 0.9 : 0.7,
        decision_guide: {
          accept_recommendation: `Call update_project_config with action: "add_tool", tool_name: "${recommendation === 'tool_a' ? nameA : nameB}"`,
          override_recommendation: `Call update_project_config with action: "add_tool", tool_name: "<user_choice>" to persist the override`,
          add_both_to_consider: `Call update_project_config with action: "add_evaluation" for each to track in pending_evaluation`,
        },
      });
    } catch (e) {
      logger.error({ err: e }, 'compare_tools failed');
      return errResult('compare_error', e instanceof Error ? e.message : String(e));
    }
  };
}

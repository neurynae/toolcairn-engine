import { config } from '@toolcairn/config';
import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, embedText, qdrantClient } from '@toolcairn/vector';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:verify-suggestion' });

const P0_PRIORITY = 2;

async function resolveToGitHubUrl(nameOrUrl: string): Promise<string> {
  if (nameOrUrl.includes('github.com') || nameOrUrl.includes('/')) return nameOrUrl;
  try {
    const token = config.GITHUB_TOKEN;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(nameOrUrl)}+in:name&sort=stars&order=desc&per_page=1`,
      { headers },
    );
    if (res.ok) {
      const data = (await res.json()) as { items?: Array<{ html_url: string }> };
      const url = data.items?.[0]?.html_url;
      if (url) return url;
    }
  } catch {
    // fall through
  }
  return nameOrUrl;
}

interface SuggestionResult {
  tool_name: string;
  status:
    | 'found_and_correct'
    | 'found_search_missed'
    | 'not_indexed_queued'
    | 'indexing_in_progress';
  in_graph: boolean;
  tool_data?: {
    description: string;
    github_url: string;
    stars: number;
    maintenance_score: number;
    last_commit: string;
    category: string;
    topics: string[];
  };
  search_miss_reason?: string;
  qdrant_present?: boolean;
  indexing_eta_seconds?: number;
  verdict?: string;
}

async function checkQdrantPresence(
  toolName: string,
): Promise<{ present: boolean; hasVector: boolean; hasTopics: boolean }> {
  try {
    const { points } = await qdrantClient().scroll(COLLECTION_NAME, {
      filter: { must: [{ key: 'name', match: { value: toolName } }] },
      limit: 1,
      with_payload: true,
      with_vector: false,
    });
    const p = points[0] as { payload: Record<string, unknown> | null } | undefined;
    if (!p?.payload) return { present: false, hasVector: false, hasTopics: false };
    return {
      present: true,
      hasVector: true,
      hasTopics: Array.isArray(p.payload.topics) && (p.payload.topics as string[]).length > 0,
    };
  } catch {
    return { present: false, hasVector: false, hasTopics: false };
  }
}

async function diagnoseSearchMiss(
  tool: ToolNode,
  usecaseRepo: ToolDeps['usecaseRepo'],
): Promise<string> {
  const reasons: string[] = [];
  const qdrantStatus = await checkQdrantPresence(tool.name);
  if (!qdrantStatus.present) {
    reasons.push(
      'not present in Qdrant vector store — tool exists in Memgraph but was never embedded',
    );
  } else if (!qdrantStatus.hasTopics) {
    reasons.push('in Qdrant but topics field is empty — embedding may use stale schema');
  }
  if (tool.health.maintenance_score < 0.3) {
    reasons.push(
      `very low health score (${Math.round(tool.health.maintenance_score * 100)}%) — may be deprioritized in Stage 3`,
    );
  }
  if (tool.category === 'other') {
    reasons.push('category is "other" — topic-based filters won\'t surface it');
  }
  const usecases = await usecaseRepo.findToolsByUseCases([tool.category], 5);
  if (!usecases.ok || usecases.data.length === 0) {
    reasons.push(`category "${tool.category}" has no matching UseCase node`);
  }
  return reasons.length > 0
    ? reasons.join('; ')
    : 'unclear — tool appears correctly indexed. May have been filtered by Stage 2 constraints.';
}

async function semanticSearch(
  query: string,
  limit = 3,
): Promise<Array<{ name: string; score: number }>> {
  try {
    const vec = await embedText(query, 'search_query');
    const results = await qdrantClient().search(COLLECTION_NAME, {
      vector: vec,
      limit,
      with_payload: true,
    });
    return (results as Array<{ payload: Record<string, unknown> | null; score: number }>)
      .filter((r) => r.payload)
      .map((r) => ({
        name: String(r.payload?.name ?? ''),
        score: Math.round(r.score * 100) / 100,
      }));
  } catch {
    return [];
  }
}

export function createVerifySuggestionHandler(
  deps: Pick<ToolDeps, 'graphRepo' | 'usecaseRepo' | 'enqueueIndexJob'>,
) {
  return async function handleVerifySuggestion(args: {
    query: string;
    agent_suggestions: string[];
  }) {
    try {
      logger.info(
        { query: args.query, suggestions: args.agent_suggestions },
        'verify_suggestion called',
      );

      const results: SuggestionResult[] = [];
      const toIndex: string[] = [];

      for (const toolName of args.agent_suggestions) {
        const found = await deps.graphRepo.findByName(toolName);
        if (found.ok && found.data) {
          const tool = found.data;
          const qdrantStatus = await checkQdrantPresence(toolName);
          const missReason = qdrantStatus.present
            ? await diagnoseSearchMiss(tool, deps.usecaseRepo)
            : 'not present in Qdrant — tool was in Memgraph but never embedded';
          const isCorrectlyIndexed =
            qdrantStatus.present && qdrantStatus.hasTopics && tool.category !== 'other';

          results.push({
            tool_name: toolName,
            status: isCorrectlyIndexed ? 'found_and_correct' : 'found_search_missed',
            in_graph: true,
            tool_data: {
              description: tool.description,
              github_url: tool.github_url,
              stars: tool.health.stars,
              maintenance_score: Math.round(tool.health.maintenance_score * 100) / 100,
              last_commit: tool.health.last_commit_date,
              category: tool.category,
              topics: tool.topics ?? [],
            },
            qdrant_present: qdrantStatus.present,
            search_miss_reason: isCorrectlyIndexed ? undefined : missReason,
            verdict: isCorrectlyIndexed
              ? `"${toolName}" is correctly indexed. Agent suggestion matches ToolPilot data.`
              : `"${toolName}" is in the graph but search missed it: ${missReason}. Triggering re-embed.`,
          });
          if (!qdrantStatus.present || !qdrantStatus.hasTopics) {
            toIndex.push(tool.github_url);
          }
        } else {
          const githubUrl = await resolveToGitHubUrl(toolName);
          toIndex.push(githubUrl);
          results.push({
            tool_name: toolName,
            status: 'not_indexed_queued',
            in_graph: false,
            indexing_eta_seconds: 120,
            verdict: `"${toolName}" is not in the ToolPilot index. Resolved to ${githubUrl !== toolName ? githubUrl : 'GitHub'} and indexing triggered at P0 priority (~2 min).`,
          });
        }
      }

      const enqueueResults = await Promise.allSettled(
        toIndex.map((id) => deps.enqueueIndexJob(id, P0_PRIORITY)),
      );
      const enqueued = enqueueResults.filter((r) => r.status === 'fulfilled').length;

      const ourRecommendations = await semanticSearch(args.query, 3);

      const agentSet = new Set(args.agent_suggestions.map((s) => s.toLowerCase()));
      const agreement = ourRecommendations.filter((r) => agentSet.has(r.name.toLowerCase()));
      const disagreement = ourRecommendations.filter((r) => !agentSet.has(r.name.toLowerCase()));
      const foundInGraph = results.filter((r) => r.in_graph).length;
      const notInGraph = results.filter((r) => !r.in_graph).length;

      logger.info({ enqueued, foundInGraph, notInGraph }, 'verify_suggestion complete');

      return okResult({
        suggestions: results,
        enqueued_for_indexing: toIndex,
        indexing_priority: 'P0 (urgent)',
        our_semantic_recommendations: ourRecommendations,
        agreement_analysis: {
          agreed_tools: agreement.map((r) => r.name),
          our_alternatives: disagreement.map((r) => r.name),
          verdict:
            agreement.length > 0
              ? `ToolPilot agrees with agent on: ${agreement.map((r) => r.name).join(', ')}.`
              : disagreement.length > 0
                ? `ToolPilot recommends different tools: ${disagreement.map((r) => r.name).join(', ')}.`
                : 'Unable to compare — index query returned no results.',
        },
        next_steps:
          toIndex.length > 0
            ? `${toIndex.length} tool(s) queued for indexing at P0. Call verify_suggestion again in ~2 minutes.`
            : 'All tools verified. Use the verdict fields above to guide tool selection.',
      });
    } catch (e) {
      logger.error({ err: e }, 'verify_suggestion failed');
      return errResult('verify_error', e instanceof Error ? e.message : String(e));
    }
  };
}

import { createLogger } from '@toolcairn/errors';
import type { SearchContext, ToolScoredResult } from '@toolcairn/search';
import { composeStack } from '@toolcairn/search';
import {
  buildLowCredibilityWarning,
  buildNonIndexedGuidance,
  formatResults,
} from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:get-stack' });

/** Tools fetched per sub-need when sub_needs are provided. */
const TOOLS_PER_NEED = 5;

/** Fallback pool size when no sub_needs — balanced BM25/vector search. */
const FALLBACK_POOL_SIZE = 25;

export function createGetStackHandler(deps: Pick<ToolDeps, 'pipeline' | 'graphRepo'>) {
  return async function handleGetStack(args: {
    use_case: string;
    sub_needs?: string[];
    constraints?: {
      deployment_model?: 'self-hosted' | 'cloud' | 'embedded' | 'serverless';
      language?: string;
      license?: string;
    };
    limit: number;
  }) {
    try {
      const { use_case, sub_needs, constraints, limit } = args;

      const filters: Record<string, unknown> = {};
      if (constraints?.language) filters.language = constraints.language;
      if (constraints?.deployment_model) filters.deployment_model = constraints.deployment_model;
      if (constraints?.license) filters.license = constraints.license;
      const context: SearchContext | undefined =
        Object.keys(filters).length > 0 ? { filters } : undefined;

      logger.info({ use_case, sub_needs, constraints }, 'get_stack called');

      // ── Build candidate pool ──────────────────────────────────────────────
      let candidates: ToolScoredResult[];

      if (sub_needs && sub_needs.length > 0) {
        // PRECISE PATH: agent called refine_requirement first and provided
        // decomposed sub-needs like ["mobile backend framework", "push notification service"].
        // Each sub-need is a single-concept query → the pipeline handles these well.
        candidates = await searchPerSubNeed(sub_needs, context, deps);
        logger.info(
          { subNeedCount: sub_needs.length, candidateCount: candidates.length },
          'per-sub-need search complete',
        );
      } else {
        // FALLBACK PATH: raw query, no decomposition. Use balanced BM25/vector
        // which provides reasonable diversity but can't match LLM decomposition.
        candidates = await deps.pipeline.runStages1to3ForStackBalanced(
          use_case,
          context,
          FALLBACK_POOL_SIZE,
        );
        logger.info({ candidateCount: candidates.length }, 'fallback balanced search complete');
      }

      if (candidates.length === 0) {
        return okResult({ use_case, stack: [] });
      }

      // ── Graph enrichment + composition (same for both paths) ──────────────
      const names = candidates.map((c) => c.tool.name);

      const ucResult = await deps.graphRepo.getToolUseCases(names);
      const toolUseCases = new Map(
        (ucResult.ok ? ucResult.data : []).map((r) => [r.toolName, r.useCases]),
      );

      const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
      const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

      const composed = composeStack(candidates, toolUseCases, pairwiseEdges, limit);

      // ── Format ────────────────────────────────────────────────────────────
      const formatted = formatResults(
        composed.tools.map((t) => ({ tool: t.tool, score: t.score })),
        false,
      );

      const stack = formatted.map((f, i) => ({
        ...f,
        // biome-ignore lint/style/noNonNullAssertion: composed.tools and formatted are same length
        role: composed.tools[i]!.role,
      }));

      const credWarning = buildLowCredibilityWarning(stack);
      const guidance = buildNonIndexedGuidance(stack, use_case);

      logger.info(
        {
          use_case,
          stackSize: stack.length,
          roles: stack.map((s) => s.role),
          mode: sub_needs ? 'decomposed' : 'fallback',
        },
        'get_stack complete',
      );

      return okResult({
        use_case,
        stack,
        ...(composed.integrationNotes.length > 0
          ? { integration_notes: composed.integrationNotes }
          : {}),
        ...(credWarning ? { credibility_warning: credWarning } : {}),
        ...(guidance ? { non_indexed_guidance: guidance } : {}),
      });
    } catch (e) {
      logger.error({ err: e }, 'get_stack threw');
      return errResult('internal_error', e instanceof Error ? e.message : String(e));
    }
  };
}

// ─── Per-sub-need search ────────────────────────────────────────────────────

/**
 * Run the search pipeline for EACH sub-need in parallel.
 * Each sub-need is a precise single-concept query — the pipeline handles these well.
 * Results are merged and deduplicated (highest score wins).
 */
async function searchPerSubNeed(
  subNeeds: string[],
  context: SearchContext | undefined,
  deps: Pick<ToolDeps, 'pipeline'>,
): Promise<ToolScoredResult[]> {
  const searches = subNeeds.map((need) =>
    deps.pipeline.runStages1to3ForStackBalanced(need, context, TOOLS_PER_NEED),
  );

  const results = await Promise.all(searches);

  // Merge: deduplicate by tool name, keep highest score
  const pool = new Map<string, ToolScoredResult>();
  for (const batch of results) {
    for (const candidate of batch) {
      const existing = pool.get(candidate.tool.name);
      if (!existing || existing.score < candidate.score) {
        pool.set(candidate.tool.name, candidate);
      }
    }
  }

  return Array.from(pool.values());
}

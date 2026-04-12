import { createLogger } from '@toolcairn/errors';
import type { SearchContext } from '@toolcairn/search';
import { composeStack } from '@toolcairn/search';
import { buildLowCredibilityWarning, buildNonIndexedGuidance, formatResults } from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:get-stack' });

/** Maximum candidates fetched from Stage 3 — matches STAGE2_TOP_N ceiling. */
const POOL_SIZE = 25;

export function createGetStackHandler(deps: Pick<ToolDeps, 'pipeline' | 'graphRepo'>) {
  return async function handleGetStack(args: {
    use_case: string;
    constraints?: {
      deployment_model?: 'self-hosted' | 'cloud' | 'embedded' | 'serverless';
      language?: string;
      license?: string;
    };
    limit: number;
  }) {
    try {
      const { use_case, constraints, limit } = args;

      // Build Stage 2 context filters from any constraints the caller provided.
      const filters: Record<string, unknown> = {};
      if (constraints?.language) filters.language = constraints.language;
      if (constraints?.deployment_model) filters.deployment_model = constraints.deployment_model;
      if (constraints?.license) filters.license = constraints.license;
      const context: SearchContext | undefined =
        Object.keys(filters).length > 0 ? { filters } : undefined;

      logger.info({ use_case, constraints }, 'get_stack called');

      // Run Stage 1-3 with full candidate pool (not user's limit).
      // The composition algorithm selects `limit` from this pool.
      const candidates = await deps.pipeline.runStages1to3ForStack(use_case, context, POOL_SIZE);

      if (candidates.length === 0) {
        logger.info({ use_case }, 'get_stack: no candidates from pipeline');
        return okResult({ use_case, stack: [] });
      }

      // Batch-fetch each candidate's SOLVES→UseCase connections (1 Cypher query).
      const names = candidates.map((c) => c.tool.name);
      const ucResult = await deps.graphRepo.getToolUseCases(names);
      const toolUseCases = new Map(
        (ucResult.ok ? ucResult.data : []).map((r) => [r.toolName, r.useCases]),
      );

      // Batch-fetch pairwise edges between candidates (1 Cypher query).
      // Returns INTEGRATES_WITH, REPLACES, CONFLICTS_WITH, etc.
      const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
      const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

      // Compose stack: set-cover diversity + integration affinity + REPLACES penalty.
      const composed = composeStack(candidates, toolUseCases, pairwiseEdges, limit);

      // Format with the same rich output as search_tools.
      const formatted = formatResults(
        composed.tools.map((t) => ({ tool: t.tool, score: t.score })),
        false,
      );

      // Merge role labels into formatted results (replace type field).
      const stack = formatted.map((f, i) => ({
        ...f,
        // biome-ignore lint/style/noNonNullAssertion: composed.tools and formatted are same length
        role: composed.tools[i]!.role,
      }));

      // Build warnings/guidance (reuse from search_tools).
      const credWarning = buildLowCredibilityWarning(stack);
      const guidance = buildNonIndexedGuidance(stack, use_case);

      logger.info(
        { use_case, stackSize: stack.length, edgeCount: pairwiseEdges.length },
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

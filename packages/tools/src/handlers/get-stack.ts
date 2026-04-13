import { createLogger } from '@toolcairn/errors';
import type { SearchContext } from '@toolcairn/search';
import { composeStack } from '@toolcairn/search';
import {
  buildLowCredibilityWarning,
  buildNonIndexedGuidance,
  formatResults,
} from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:get-stack' });

/** Candidate pool size from balanced search. */
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

      const filters: Record<string, unknown> = {};
      if (constraints?.language) filters.language = constraints.language;
      if (constraints?.deployment_model) filters.deployment_model = constraints.deployment_model;
      if (constraints?.license) filters.license = constraints.license;
      const context: SearchContext | undefined =
        Object.keys(filters).length > 0 ? { filters } : undefined;

      logger.info({ use_case, constraints }, 'get_stack called');

      // Balanced BM25/vector search — BM25 finds tools for EACH query token
      // independently (database tools, auth tools, chat tools) while vector
      // provides quality filtering. No facet detection or per-facet search needed.
      const candidates = await deps.pipeline.runStages1to3ForStackBalanced(
        use_case,
        context,
        POOL_SIZE,
      );

      if (candidates.length === 0) {
        return okResult({ use_case, stack: [] });
      }

      // Batch-fetch UseCase connections + pairwise edges (existing, 2 queries)
      const names = candidates.map((c) => c.tool.name);
      const ucResult = await deps.graphRepo.getToolUseCases(names);
      const toolUseCases = new Map(
        (ucResult.ok ? ucResult.data : []).map((r) => [r.toolName, r.useCases]),
      );

      const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
      const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

      // Compose stack: UseCase set-cover + integration + REPLACES penalty
      const composed = composeStack(candidates, toolUseCases, pairwiseEdges, limit);

      // Format with rich output
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
        { use_case, stackSize: stack.length, roles: stack.map((s) => s.role) },
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

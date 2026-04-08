import type { SearchContext } from '@toolcairn/search';
import pino from 'pino';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:get-stack' });

export function createGetStackHandler(deps: Pick<ToolDeps, 'pipeline'>) {
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
      // These are forwarded to stage2ApplyFilters as Qdrant payload filters.
      const filters: Record<string, unknown> = {};
      if (constraints?.language) filters.language = constraints.language;
      if (constraints?.deployment_model) filters.deployment_model = constraints.deployment_model;
      if (constraints?.license) filters.license = constraints.license;
      const context: SearchContext | undefined =
        Object.keys(filters).length > 0 ? { filters } : undefined;

      logger.info({ use_case, constraints }, 'get_stack called');

      // Run Stage 1 (BM25+vector hybrid) → Stage 2 (filters) → Stage 3 (graph rerank).
      // Stage 4 is intentionally skipped: it's a single-winner precision selector,
      // but stack builder needs the top N ranked tools, not just one winner.
      const scored = await deps.pipeline.runStages1to3ForStack(use_case, context, limit);

      const results = scored.map((r) => ({
        name: r.tool.name,
        display_name: r.tool.display_name,
        description: r.tool.description,
        category: r.tool.category,
        github_url: r.tool.github_url,
        maintenance_score: r.tool.health.maintenance_score,
      }));

      logger.info({ use_case, resultCount: results.length }, 'get_stack complete');
      return okResult({ use_case, tools: results });
    } catch (e) {
      logger.error({ err: e }, 'get_stack threw');
      return errResult('internal_error', e instanceof Error ? e.message : String(e));
    }
  };
}

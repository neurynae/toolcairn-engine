import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { SearchContext, ToolScoredResult } from '@toolcairn/search';
import {
  composeStack,
  expandWithCooccurrence,
  getUseCaseBm25Index,
  searchUseCaseBm25,
} from '@toolcairn/search';
import {
  buildLowCredibilityWarning,
  buildNonIndexedGuidance,
  formatResults,
} from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:get-stack' });

/** Max primary facets extracted from the query via BM25. */
const MAX_PRIMARY_FACETS = 4;

/** Tools fetched per expanded facet from the SOLVES graph. */
const TOOLS_PER_FACET = 5;

/** Backup pool from the full-query pipeline (existing Stage 1-3). */
const BACKUP_POOL_SIZE = 25;

export function createGetStackHandler(
  deps: Pick<ToolDeps, 'pipeline' | 'graphRepo' | 'usecaseRepo'>,
) {
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

      // ── PHASE 1: Facet detection via BM25 on UseCase names ──
      const ucIndex = await getUseCaseBm25Index(deps.usecaseRepo);
      const primaryFacets = searchUseCaseBm25(use_case, ucIndex, MAX_PRIMARY_FACETS);
      const primaryFacetNames = primaryFacets.map((f) => f.name);

      logger.info({ primaryFacets: primaryFacetNames }, 'detected primary facets');

      // ── PHASE 2: Co-occurrence expansion ──
      const expandedFacets = await expandWithCooccurrence(primaryFacetNames, deps.usecaseRepo);

      logger.info(
        { expanded: expandedFacets.length, facets: expandedFacets.slice(0, 8) },
        'expanded facets',
      );

      // ── PHASE 3: Parallel search — per-facet + backup ──
      const [facetResults, backupResults] = await Promise.all([
        discoverToolsPerFacet(expandedFacets, deps),
        deps.pipeline.runStages1to3ForStack(use_case, context, BACKUP_POOL_SIZE),
      ]);

      // ── PHASE 4: Pool merge with facet provenance tracking ──
      const { candidates, facetProvenance } = mergePool(facetResults, backupResults);

      if (candidates.length === 0) {
        logger.info({ use_case }, 'get_stack: no candidates after merge');
        return okResult({ use_case, stack: [] });
      }

      logger.info(
        {
          poolSize: candidates.length,
          facetTools: facetResults.length,
          backupTools: backupResults.length,
        },
        'pool merged',
      );

      // ── PHASE 5: Existing — UseCase resolution + pairwise edges ──
      const names = candidates.map((c) => c.tool.name);
      const ucResult = await deps.graphRepo.getToolUseCases(names);
      const toolUseCases = new Map(
        (ucResult.ok ? ucResult.data : []).map((r) => [r.toolName, r.useCases]),
      );

      const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
      const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

      // ── PHASE 6: Compose stack with facet provenance for role labels ──
      const composed = composeStack(
        candidates,
        toolUseCases,
        pairwiseEdges,
        limit,
        facetProvenance,
      );

      // ── PHASE 7: Format + warnings ──
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
          facets: primaryFacetNames,
          roles: stack.map((s) => s.role),
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

// ─── Per-facet tool discovery ───────────────────────────────────────────────

interface FacetToolResult {
  facet: string;
  tool: ToolNode;
  score: number;
}

/**
 * For each expanded facet, find the top tools that SOLVE it via graph edges.
 * Returns a flat array of { facet, tool, score } entries.
 */
async function discoverToolsPerFacet(
  facets: string[],
  deps: Pick<ToolDeps, 'usecaseRepo'>,
): Promise<FacetToolResult[]> {
  const results: FacetToolResult[] = [];

  // Run per-facet queries in parallel (each is ~20ms)
  const facetPromises = facets.map(async (facet) => {
    const result = await deps.usecaseRepo.findToolsByUseCasesScored([facet], TOOLS_PER_FACET);
    if (!result.ok) return [];
    return result.data.map(({ tool, score }) => ({ facet, tool, score }));
  });

  const batchResults = await Promise.all(facetPromises);
  for (const batch of batchResults) {
    results.push(...batch);
  }

  return results;
}

// ─── Pool merge ─────────────────────────────────────────────────────────────

/**
 * Cap for per-facet tool scores. Keeps them competitive with backup tools
 * for high-quality tools, but ensures junk tools with low health stay low.
 */
const FACET_SCORE_CAP = 0.55;

/**
 * Merge per-facet tool discoveries with backup pipeline results into a single
 * diverse candidate pool. Tracks which facet discovered each tool (for role labels).
 *
 * Per-facet tools are scored by QUALITY (maintenance × credibility), not raw
 * SOLVES edge weight. SOLVES edge weights are all 0.8 (uniform from indexer),
 * so normalizing them produces identical scores and allows irrelevant tools
 * (e.g. a game tagged "real-time") to beat backup candidates. Quality scoring
 * ensures well-maintained, credible tools win within each facet.
 *
 * Backup pipeline tools keep their Stage 3 scores, which reflect full-query
 * relevance. A tool found by BOTH per-facet AND backup gets the higher of the
 * two scores (dual-discovery bonus).
 */
function mergePool(
  facetResults: FacetToolResult[],
  backupResults: ToolScoredResult[],
): { candidates: ToolScoredResult[]; facetProvenance: Map<string, string> } {
  const pool = new Map<string, ToolScoredResult>();
  const provenance = new Map<string, string>();

  // Per-facet tools: score by health quality (maintenance × credibility)
  // This filters out low-quality tools that happen to match a UseCase tag
  for (const { facet, tool } of facetResults) {
    const maintenance = tool.health.maintenance_score ?? 0;
    const credibility = tool.health.credibility_score ?? 0.5;
    const qualityScore = Math.min(maintenance * credibility, FACET_SCORE_CAP);

    const existing = pool.get(tool.name);
    if (!existing || existing.score < qualityScore) {
      pool.set(tool.name, { tool, score: qualityScore });
    }
    if (!provenance.has(tool.name)) {
      provenance.set(tool.name, facet);
    }
  }

  // Backup tools keep their Stage 3 scores (full-query relevance signal).
  // If a tool is in both per-facet and backup, take the higher score.
  for (const candidate of backupResults) {
    const existing = pool.get(candidate.tool.name);
    if (!existing || existing.score < candidate.score) {
      pool.set(candidate.tool.name, { ...candidate });
      // Keep existing facet provenance if it was set by per-facet discovery
    }
  }

  return {
    candidates: Array.from(pool.values()),
    facetProvenance: provenance,
  };
}

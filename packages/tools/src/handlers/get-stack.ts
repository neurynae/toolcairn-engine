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

/** Tools fetched per sub-need via full BM25+vector pipeline. */
const TOOLS_PER_NEED = 5;

/** Fallback pool size when no sub_needs — balanced BM25/vector. */
const FALLBACK_POOL_SIZE = 25;

/** Structured sub-need with keyword-based search. */
export interface KeywordSubNeed {
  sub_need_type: string;
  keyword_sentence: string;
}

export function createGetStackHandler(deps: Pick<ToolDeps, 'pipeline' | 'graphRepo'>) {
  return async function handleGetStack(args: {
    use_case: string;
    sub_needs?: Array<string | KeywordSubNeed>;
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

      if (sub_needs && sub_needs.length > 0) {
        // Detect format: all structured objects vs all legacy strings.
        // Mixed arrays are invalid — treat as legacy (strings) with a warning.
        const isStructured = sub_needs.every((n) => typeof n === 'object' && n !== null);

        if (isStructured) {
          // ── KEYWORD PATH: per-type keyword-matched search ──
          const structured = sub_needs as KeywordSubNeed[];
          return await buildStackFromKeywordNeeds(structured, use_case, context, limit, deps);
        }

        // ── LEGACY PATH: per-sub-need search with guaranteed layer slots ──
        const strings = sub_needs.filter((n): n is string => typeof n === 'string');
        if (strings.length < sub_needs.length) {
          logger.warn(
            { total: sub_needs.length, strings: strings.length },
            'Mixed sub_needs array — filtering to strings only',
          );
        }
        return await buildStackFromSubNeeds(strings, use_case, context, limit, deps);
      }

      // ── FALLBACK PATH: balanced BM25/vector on the raw query ─────────────
      const candidates = await deps.pipeline.runStages1to3ForStackBalanced(
        use_case,
        context,
        FALLBACK_POOL_SIZE,
      );
      logger.info({ candidateCount: candidates.length }, 'fallback balanced search complete');

      if (candidates.length === 0) {
        return okResult({ use_case, stack: [] });
      }

      const names = candidates.map((c) => c.tool.name);
      const ucResult = await deps.graphRepo.getToolUseCases(names);
      const toolUseCases = new Map(
        (ucResult.ok ? ucResult.data : []).map((r) => [r.toolName, r.useCases]),
      );
      const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
      const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

      const composed = composeStack(candidates, toolUseCases, pairwiseEdges, limit);
      return formatAndReturn(use_case, composed, 'fallback');
    } catch (e) {
      logger.error({ err: e }, 'get_stack threw');
      return errResult('internal_error', e instanceof Error ? e.message : String(e));
    }
  };
}

// ─── Precise path: guaranteed one tool per sub-need ─────────────────────────

/**
 * Search per sub-need, then assemble a stack that GUARANTEES at least one tool
 * per sub-need (layer). This prevents popular generic tools (Kubernetes, Bootstrap)
 * from stealing slots meant for specific layers (payment processor, push service).
 *
 * Algorithm:
 * 1. Search each sub-need independently → get ranked candidates per need
 * 2. Pick the BEST tool for each sub-need (guaranteed slot)
 *    - Skip tools already picked by a previous sub-need
 * 3. If limit > sub_needs.length, fill remaining slots from leftover candidates
 *    ranked by score, using UseCase set-cover for diversity
 * 4. Role = the sub-need description that found the tool (human-readable layer name)
 */
async function buildStackFromSubNeeds(
  subNeeds: string[],
  useCase: string,
  context: SearchContext | undefined,
  limit: number,
  deps: Pick<ToolDeps, 'pipeline' | 'graphRepo'>,
) {
  // 1. Search each sub-need: BM25 + vector (Stage 1) → credibility (Stage 2).
  //    Stage 3 graph rerank is SKIPPED for sub-needs — it amplifies popular
  //    generic tools via graph connectivity, which is noise for precise queries.
  const perNeedResults: Array<{ need: string; tools: ToolScoredResult[] }> = [];
  for (const need of subNeeds) {
    const tools = await deps.pipeline.runStages1to2ForSubNeed(need, context, TOOLS_PER_NEED);
    perNeedResults.push({ need, tools });
  }

  logger.info(
    {
      subNeedCount: subNeeds.length,
      perNeedCounts: perNeedResults.map((r) => r.tools.length),
    },
    'per-sub-need search complete',
  );

  // 2. Pick best tool per sub-need (guaranteed layer slots)
  const selected: Array<{ tool: ToolScoredResult; role: string }> = [];
  const usedNames = new Set<string>();

  for (const { need, tools } of perNeedResults) {
    if (selected.length >= limit) break;

    // Find the highest-scored tool not already selected
    for (const tool of tools) {
      if (!usedNames.has(tool.tool.name)) {
        selected.push({ tool, role: formatSubNeedAsRole(need) });
        usedNames.add(tool.tool.name);
        break;
      }
    }
  }

  // 3. Fill remaining slots from leftover candidates (if limit > sub_needs)
  if (selected.length < limit) {
    const leftoverPool: ToolScoredResult[] = [];
    for (const { tools } of perNeedResults) {
      for (const tool of tools) {
        if (!usedNames.has(tool.tool.name)) {
          leftoverPool.push(tool);
        }
      }
    }

    // Sort by score, pick best remaining until limit
    leftoverPool.sort((a, b) => b.score - a.score);
    for (const tool of leftoverPool) {
      if (selected.length >= limit) break;
      if (usedNames.has(tool.tool.name)) continue;
      selected.push({ tool, role: tool.tool.category });
      usedNames.add(tool.tool.name);
    }
  }

  if (selected.length === 0) {
    return okResult({ use_case: useCase, stack: [] });
  }

  // 4. Graph enrichment for integration notes
  const names = selected.map((s) => s.tool.tool.name);
  const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
  const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];
  const integrationNotes = buildIntegrationNotes(selected, pairwiseEdges);

  // 5. Format
  const formatted = formatResults(
    selected.map((s) => ({ tool: s.tool.tool, score: s.tool.score })),
    false,
  );

  const stack = formatted.map((f, i) => ({
    ...f,
    // biome-ignore lint/style/noNonNullAssertion: same length
    role: selected[i]!.role,
  }));

  const credWarning = buildLowCredibilityWarning(stack);
  const guidance = buildNonIndexedGuidance(stack, useCase);

  logger.info(
    {
      use_case: useCase,
      stackSize: stack.length,
      roles: stack.map((s) => s.role),
      mode: 'decomposed',
    },
    'get_stack complete',
  );

  return okResult({
    use_case: useCase,
    stack,
    ...(integrationNotes.length > 0 ? { integration_notes: integrationNotes } : {}),
    ...(credWarning ? { credibility_warning: credWarning } : {}),
    ...(guidance ? { non_indexed_guidance: guidance } : {}),
  });
}

// ─── Keyword path: type-segregated keyword-matched search ─────────────────

/**
 * Search per keyword sub-need, then assemble a stack with one tool per
 * sub_need_type. Uses the new keyword-sentence BM25 pipeline for retrieval
 * and 3-edge graph verification (REPLACES / INTEGRATES_WITH / REQUIRES).
 */
async function buildStackFromKeywordNeeds(
  subNeeds: KeywordSubNeed[],
  useCase: string,
  context: SearchContext | undefined,
  limit: number,
  deps: Pick<ToolDeps, 'pipeline' | 'graphRepo'>,
) {
  // 1. Search each sub-need via keyword-matched pipeline
  const perNeedResults: Array<{
    type: string;
    tools: ToolScoredResult[];
  }> = [];
  for (const need of subNeeds) {
    const tools = await deps.pipeline.runKeywordSearch(
      need.keyword_sentence,
      context,
      TOOLS_PER_NEED,
    );
    perNeedResults.push({ type: need.sub_need_type, tools });
  }

  logger.info(
    {
      subNeedCount: subNeeds.length,
      perNeedCounts: perNeedResults.map((r) => r.tools.length),
      types: perNeedResults.map((r) => r.type),
    },
    'keyword sub-need search complete',
  );

  // 2. Pick best tool per sub_need_type (guaranteed layer slots)
  const selected: Array<{ tool: ToolScoredResult; role: string }> = [];
  const usedNames = new Set<string>();

  for (const { type, tools } of perNeedResults) {
    if (selected.length >= limit) break;

    for (const tool of tools) {
      if (!usedNames.has(tool.tool.name)) {
        selected.push({ tool, role: type });
        usedNames.add(tool.tool.name);
        break;
      }
    }
  }

  // 3. Fill remaining slots from leftover candidates (if limit > sub_needs)
  if (selected.length < limit) {
    const leftoverPool: ToolScoredResult[] = [];
    for (const { tools } of perNeedResults) {
      for (const tool of tools) {
        if (!usedNames.has(tool.tool.name)) {
          leftoverPool.push(tool);
        }
      }
    }

    leftoverPool.sort((a, b) => b.score - a.score);
    for (const tool of leftoverPool) {
      if (selected.length >= limit) break;
      if (usedNames.has(tool.tool.name)) continue;
      selected.push({ tool, role: tool.tool.category });
      usedNames.add(tool.tool.name);
    }
  }

  if (selected.length === 0) {
    return okResult({ use_case: useCase, stack: [] });
  }

  // 4. Graph verification: 3-edge cross-type check
  const names = selected.map((s) => s.tool.tool.name);
  const edgeResult = await deps.graphRepo.getPairwiseEdges(names);
  const pairwiseEdges = edgeResult.ok ? edgeResult.data : [];

  // REPLACES: if two tools with same role are alternatives, keep higher score
  const replacesEdges = pairwiseEdges.filter((e) => e.edgeType === 'REPLACES');
  for (const edge of replacesEdges) {
    const srcEntry = selected.find((s) => s.tool.tool.name === edge.source);
    const tgtEntry = selected.find((s) => s.tool.tool.name === edge.target);
    if (srcEntry && tgtEntry && srcEntry.role === tgtEntry.role) {
      const toRemove = srcEntry.tool.score >= tgtEntry.tool.score ? tgtEntry : srcEntry;
      const idx = selected.indexOf(toRemove);
      if (idx >= 0) selected.splice(idx, 1);
    }
  }

  // INTEGRATES_WITH: cross-type compatibility signal
  const integrationNotes = buildIntegrationNotes(selected, pairwiseEdges);

  // REQUIRES: dependency satisfaction signal
  const requiresNotes = buildRequiresNotes(selected, pairwiseEdges);

  // 5. Format
  const formatted = formatResults(
    selected.map((s) => ({ tool: s.tool.tool, score: s.tool.score })),
    false,
  );

  const stack = formatted.map((f, i) => ({
    ...f,
    // biome-ignore lint/style/noNonNullAssertion: same length
    role: selected[i]!.role,
  }));

  const credWarning = buildLowCredibilityWarning(stack);
  const guidance = buildNonIndexedGuidance(stack, useCase);

  logger.info(
    {
      use_case: useCase,
      stackSize: stack.length,
      roles: stack.map((s) => s.role),
      mode: 'keyword',
    },
    'get_stack complete',
  );

  return okResult({
    use_case: useCase,
    stack,
    ...(integrationNotes.length > 0 ? { integration_notes: integrationNotes } : {}),
    ...(requiresNotes.length > 0 ? { requires_notes: requiresNotes } : {}),
    ...(credWarning ? { credibility_warning: credWarning } : {}),
    ...(guidance ? { non_indexed_guidance: guidance } : {}),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a sub-need description into a concise role label.
 * "open source authentication identity platform with SSO and JWT" → "Authentication identity platform"
 * Takes the first 3-5 meaningful words after stripping common prefixes.
 */
function formatSubNeedAsRole(need: string): string {
  const stripped = need
    .replace(/^(open[- ]source|self[- ]hosted|free|lightweight)\s+/i, '')
    .replace(/\s+(for|with|using|based on|in|and)\s+.*/i, '');
  const words = stripped.split(/\s+/).slice(0, 4);
  const label = words.join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Build integration notes from INTEGRATES_WITH edges between selected tools. */
function buildIntegrationNotes(
  selected: Array<{ tool: ToolScoredResult; role: string }>,
  pairwiseEdges: Array<{
    source: string;
    target: string;
    edgeType: string;
    effectiveWeight: number;
  }>,
): string[] {
  const names = new Set(selected.map((s) => s.tool.tool.name));
  const notes: string[] = [];
  for (const edge of pairwiseEdges) {
    if (names.has(edge.source) && names.has(edge.target)) {
      if (edge.edgeType === 'INTEGRATES_WITH') {
        const srcDisplay =
          selected.find((s) => s.tool.tool.name === edge.source)?.tool.tool.display_name ??
          edge.source;
        const tgtDisplay =
          selected.find((s) => s.tool.tool.name === edge.target)?.tool.tool.display_name ??
          edge.target;
        notes.push(`${srcDisplay} integrates with ${tgtDisplay}`);
      }
    }
  }
  return notes;
}

/** Build requires notes from REQUIRES edges between selected tools. */
function buildRequiresNotes(
  selected: Array<{ tool: ToolScoredResult; role: string }>,
  pairwiseEdges: Array<{
    source: string;
    target: string;
    edgeType: string;
    effectiveWeight: number;
  }>,
): string[] {
  const names = new Set(selected.map((s) => s.tool.tool.name));
  const notes: string[] = [];
  for (const edge of pairwiseEdges) {
    if (edge.edgeType === 'REQUIRES' && names.has(edge.source) && names.has(edge.target)) {
      const srcDisplay =
        selected.find((s) => s.tool.tool.name === edge.source)?.tool.tool.display_name ??
        edge.source;
      const tgtDisplay =
        selected.find((s) => s.tool.tool.name === edge.target)?.tool.tool.display_name ??
        edge.target;
      // Pairwise query is undirected — don't imply direction
      notes.push(
        `${srcDisplay} and ${tgtDisplay} have a dependency relationship (satisfied in this stack)`,
      );
    }
  }
  return notes;
}

/** Format and return the final stack response. */
function formatAndReturn(
  useCase: string,
  composed: { tools: Array<ToolScoredResult & { role: string }>; integrationNotes: string[] },
  mode: string,
) {
  const formatted = formatResults(
    composed.tools.map((t) => ({ tool: t.tool, score: t.score })),
    false,
  );

  const stack = formatted.map((f, i) => ({
    ...f,
    // biome-ignore lint/style/noNonNullAssertion: same length
    role: composed.tools[i]!.role,
  }));

  const credWarning = buildLowCredibilityWarning(stack);
  const guidance = buildNonIndexedGuidance(stack, useCase);

  logger.info(
    { use_case: useCase, stackSize: stack.length, roles: stack.map((s) => s.role), mode },
    'get_stack complete',
  );

  return okResult({
    use_case: useCase,
    stack,
    ...(composed.integrationNotes.length > 0
      ? { integration_notes: composed.integrationNotes }
      : {}),
    ...(credWarning ? { credibility_warning: credWarning } : {}),
    ...(guidance ? { non_indexed_guidance: guidance } : {}),
  });
}

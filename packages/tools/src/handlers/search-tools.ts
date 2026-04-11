import { createLogger } from '@toolcairn/errors';
import { buildExactLookupMaps, stage0ExactResolve, stage1HybridSearch } from '@toolcairn/search';
import {
  buildLowCredibilityWarning,
  buildNonIndexedGuidance,
  formatResults,
} from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:search-tools' });

const CLARIFICATION_THRESHOLD = 3;

export function createSearchToolsHandler(
  deps: Pick<
    ToolDeps,
    'pipeline' | 'sessionManager' | 'clarificationEngine' | 'enqueueSearchEvent'
  >,
) {
  return async function handleSearchTools(args: {
    query: string;
    context?: { filters: Record<string, unknown> };
    query_id?: string;
    user_id?: string;
  }) {
    try {
      const sessionId = args.query_id ?? (await deps.sessionManager.createSession(args.query));
      logger.info({ sessionId, query: args.query }, 'search_tools called');

      if (args.context) {
        await deps.sessionManager.updateContext(sessionId, args.context);
      }

      const t0 = Date.now();

      const corpus = await deps.pipeline.loadToolCorpus();

      // Stage 0 — exact-match short-circuit: resolve direct name/package queries
      // without running the expensive Stage 1 (BM25 + vector + Qdrant) pipeline.
      const lookupMaps = buildExactLookupMaps(corpus);
      const stage0 = stage0ExactResolve(args.query, lookupMaps);
      if (stage0.match) {
        const total_ms = Date.now() - t0;
        logger.info({ sessionId, tool: stage0.match.name, total_ms }, 'Stage 0 exact match');
        const formattedExact = formatResults([{ tool: stage0.match, score: 1.0 }], false);
        deps.enqueueSearchEvent(args.query, sessionId).catch(() => {});
        await deps.sessionManager.saveResults(sessionId, [{ tool: stage0.match, score: 1.0 }]);
        return okResult({
          query_id: sessionId,
          status: 'complete',
          stage: 4,
          results: formattedExact,
          is_two_option: false,
          timing: { stage1_ms: 0, stage2_ms: 0, stage3_ms: 0, stage4_ms: 0, total_ms },
          non_indexed_guidance: buildNonIndexedGuidance(formattedExact, args.query),
          credibility_warning: buildLowCredibilityWarning(formattedExact),
        });
      }

      const stage1 = await stage1HybridSearch(args.query, corpus, lookupMaps);

      const idSet = new Set(stage1.ids);
      const candidates = corpus.filter((t) => idSet.has(t.id));

      const askedDimensions = await deps.sessionManager.getAskedDimensions(sessionId);
      const questions = deps.clarificationEngine.getClarification(candidates, askedDimensions);

      if (questions.length > 0 && candidates.length > CLARIFICATION_THRESHOLD) {
        await deps.sessionManager.saveCandidates(sessionId, stage1.ids);
        await deps.sessionManager.appendClarification(sessionId, questions, []);

        deps.enqueueSearchEvent(args.query, sessionId).catch((e: unknown) => {
          logger.warn({ err: e }, 'Failed to enqueue search event');
        });

        logger.info(
          { sessionId, candidateCount: candidates.length, questionCount: questions.length },
          'Clarification needed',
        );
        const clarificationRound = deps.pipeline.getClarificationRound([...askedDimensions]);
        return okResult({
          query_id: sessionId,
          status: 'clarification_needed',
          stage: 1,
          clarification_round: clarificationRound,
          candidate_count: candidates.length,
          questions,
          hint: 'Answer to narrow the search. Up to 2 more rounds of clarification may follow.',
        });
      }

      const { results, is_two_option, stage2_ms, stage3_ms, stage4_ms } =
        await deps.pipeline.runStages2to4(stage1.ids, args.context, sessionId);

      deps.enqueueSearchEvent(args.query, sessionId).catch((e: unknown) => {
        logger.warn({ err: e }, 'Failed to enqueue search event');
      });

      const total_ms = Date.now() - t0;
      logger.info({ sessionId, total_ms, resultCount: results.length }, 'search_tools complete');

      const formattedResults = formatResults(results, is_two_option);
      const nonIndexedGuidance = buildNonIndexedGuidance(formattedResults, args.query);
      const credibilityWarning = buildLowCredibilityWarning(formattedResults);

      return okResult({
        query_id: sessionId,
        status: 'complete',
        stage: 4,
        results: formattedResults,
        is_two_option,
        timing: { stage1_ms: stage1.elapsed_ms, stage2_ms, stage3_ms, stage4_ms, total_ms },
        ...(nonIndexedGuidance ? { non_indexed_guidance: nonIndexedGuidance } : {}),
        ...(credibilityWarning ? { credibility_warning: credibilityWarning } : {}),
      });
    } catch (e) {
      logger.error({ err: e, query: args.query }, 'search_tools failed');
      return errResult('search_error', e instanceof Error ? e.message : String(e));
    }
  };
}

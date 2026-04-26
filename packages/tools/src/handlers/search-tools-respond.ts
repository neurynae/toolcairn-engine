import { createLogger } from '@toolcairn/errors';
import {
  buildLowCredibilityWarning,
  buildNonIndexedGuidance,
  formatResults,
} from '../format-results.js';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:search-tools-respond' });

export function createSearchToolsRespondHandler(
  deps: Pick<ToolDeps, 'pipeline' | 'sessionManager' | 'clarificationEngine'>,
) {
  return async function handleSearchToolsRespond(args: {
    query_id: string;
    answers: Array<{ dimension: string; value: string }>;
  }) {
    try {
      const session = await deps.sessionManager.getSession(args.query_id);
      if (!session) {
        return errResult('session_not_found', `No session found for query_id: ${args.query_id}`);
      }

      logger.info(
        { sessionId: args.query_id, answerCount: args.answers.length },
        'search_tools_respond called',
      );

      const candidateIds = await deps.sessionManager.getCandidates(args.query_id);
      if (candidateIds.length === 0) {
        return errResult(
          'no_candidates',
          'No saved candidates for this session. Call search_tools first.',
        );
      }

      const filterUpdates: Record<string, string> = {};
      for (const answer of args.answers) {
        filterUpdates[answer.dimension] = answer.value;
      }
      const prevContext = (session.context as Record<string, unknown> | null) ?? {};
      const updatedContext = {
        ...prevContext,
        filters: {
          ...((prevContext.filters as Record<string, unknown>) ?? {}),
          ...filterUpdates,
        },
      };
      await deps.sessionManager.updateContext(args.query_id, updatedContext);
      await deps.sessionManager.appendClarification(args.query_id, [], args.answers);

      const allAskedDimensions = await deps.sessionManager.getAskedDimensions(args.query_id);

      if (allAskedDimensions.size < 3) {
        const corpus = await deps.pipeline.loadToolCorpus();
        const idSet = new Set(candidateIds);
        const candidateTools = corpus.filter((t) => idSet.has(t.id));
        const filteredCandidates = deps.clarificationEngine.applyAnswers(
          candidateTools,
          args.answers,
        );

        const nextQuestions = deps.clarificationEngine.getClarification(
          filteredCandidates,
          allAskedDimensions,
        );

        if (nextQuestions.length > 0) {
          await deps.sessionManager.appendClarification(args.query_id, nextQuestions, []);
          const clarificationRound = allAskedDimensions.size + 1;
          logger.info(
            { sessionId: args.query_id, clarificationRound, questionCount: nextQuestions.length },
            'search_tools_respond: next clarification round',
          );
          return okResult({
            done: false,
            query_id: args.query_id,
            status: 'clarification_needed',
            stage: 2,
            clarification_round: clarificationRound,
            questions: nextQuestions,
          });
        }
      }

      const { results, alternatives, is_two_option } = await deps.pipeline.runStages2to4(
        candidateIds,
        updatedContext,
        args.query_id,
      );

      logger.info(
        { sessionId: args.query_id, resultCount: results.length },
        'search_tools_respond complete',
      );

      const sessionForQuery = await deps.sessionManager.getSession(args.query_id);
      const originalQuery = (sessionForQuery?.query as string) ?? '';
      const formattedResults = formatResults(results, is_two_option);
      const formattedAlternatives = formatResults(alternatives, false);
      const nonIndexedGuidance = buildNonIndexedGuidance(formattedResults, originalQuery);
      const credibilityWarning = buildLowCredibilityWarning(formattedResults);

      return okResult({
        done: true,
        query_id: args.query_id,
        status: 'complete',
        stage: 4,
        results: formattedResults,
        alternatives: formattedAlternatives,
        is_two_option,
        ...(nonIndexedGuidance ? { non_indexed_guidance: nonIndexedGuidance } : {}),
        ...(credibilityWarning ? { credibility_warning: credibilityWarning } : {}),
      });
    } catch (e) {
      logger.error({ err: e, query_id: args.query_id }, 'search_tools_respond failed');
      return errResult('search_error', e instanceof Error ? e.message : String(e));
    }
  };
}

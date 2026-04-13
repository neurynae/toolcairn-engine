// @toolcairn/search — 4-stage guided search pipeline

export { SearchError } from './errors.js';
export type {
  ClarificationAnswer,
  ClarificationQuestion,
  SearchContext,
  SearchPipelineInput,
  SearchPipelineResult,
  Stage1Result,
  Stage2Result,
  Stage3Result,
  Stage4Result,
  ToolScoredResult,
} from './types.js';
export { SearchSessionManager } from './session.js';
export { ClarificationEngine } from './clarification/engine.js';
export { InformationGainCalculator } from './clarification/gain.js';
export { SearchPipeline } from './pipeline.js';
export type { RunStages2to4Result } from './pipeline.js';
export { stage1HybridSearch } from './stages/stage1-hybrid.js';
export {
  buildExactLookupMaps,
  stage0ExactResolve,
} from './stages/stage0-exact.js';
export type { ExactLookupMaps, Stage0Result } from './stages/stage0-exact.js';
export { expandQueryAliases, ALIAS_MAP } from './aliases.js';
export { composeStack, type ComposedStack } from './stages/stack-compose.js';
export {
  buildUseCaseBm25Index,
  getUseCaseBm25Index,
  searchUseCaseBm25,
  type UseCaseBm25Index,
  type UseCaseBm25Match,
} from './facets/usecase-index.js';
export { expandWithCooccurrence } from './facets/expand.js';
export { classifyQueryIntent, getIntentWeights } from './query-intent.js';
export type { QueryIntent, IntentWeights } from './query-intent.js';
export { expandQueryWithGraphEntities } from './query-expander.js';

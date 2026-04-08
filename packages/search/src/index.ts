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

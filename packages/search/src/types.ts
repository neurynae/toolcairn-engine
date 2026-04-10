import type { ToolNode } from '@toolcairn/core';

export interface SearchContext {
  filters: Record<string, unknown>;
}

export interface SearchPipelineInput {
  query: string;
  sessionId: string;
  context?: SearchContext;
  /** Authenticated user ID — enables preference-based result boosting */
  userId?: string;
}

export interface ClarificationQuestion {
  dimension: string;
  question: string;
  options: string[];
}

export interface ClarificationAnswer {
  dimension: string;
  value: string;
}

export interface ToolScoredResult {
  tool: ToolNode;
  score: number;
}

export interface Stage1Result {
  ids: string[];
  elapsed_ms: number;
  /** Detected query intent — propagated to Stage 3 for weight adjustments */
  intent?: import('./query-intent.js').QueryIntent;
}

export interface Stage2Result {
  hits: Array<{ tool: ToolNode; score: number }>;
  elapsed_ms: number;
}

export interface Stage3Result {
  results: ToolScoredResult[];
  elapsed_ms: number;
}

export interface Stage4Result {
  results: ToolScoredResult[];
  is_two_option: boolean;
  elapsed_ms: number;
}

export interface SearchPipelineResult {
  sessionId: string;
  query: string;
  results: ToolScoredResult[];
  is_two_option: boolean;
  stage1_ms: number;
  stage2_ms: number;
  stage3_ms: number;
  stage4_ms: number;
  total_ms: number;
}

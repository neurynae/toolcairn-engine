import type { ToolNode } from '@toolcairn/core';

export interface SearchContext {
  filters: Record<string, unknown>;
}

export interface SearchPipelineInput {
  query: string;
  sessionId: string;
  context?: SearchContext;
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

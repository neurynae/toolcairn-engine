export type Severity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Contextual metadata attached to every AppError.
 * Carries structured debugging information — what was happening, who/what was involved.
 */
export interface ErrorContext {
  /** Package or module where the error originated, e.g. '@toolcairn/graph' */
  module?: string;
  /** The operation being performed, e.g. 'createTool' */
  operation?: string;
  /** Correlation/request ID for tracing across service boundaries */
  requestId?: string;
  /** Any additional domain-specific fields (toolId, sessionId, userId, etc.) */
  [key: string]: unknown;
}

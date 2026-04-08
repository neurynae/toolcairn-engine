/**
 * @toolcairn/tools — Shared tool handler logic with dependency injection.
 *
 * Usage:
 *   import { createDeps, createAllHandlers } from '@toolcairn/tools';
 *   const deps = createDeps();
 *   const handlers = createAllHandlers(deps);
 */

// Types + factory
export type { ToolDeps } from './types.js';
export { createDeps } from './deps.js';

// Zod input schemas (shared by MCP server + HTTP API)
export * from './schemas.js';

// Utilities
export { okResult, errResult } from './utils.js';
export {
  formatResults,
  buildNonIndexedGuidance,
  buildLowCredibilityWarning,
} from './format-results.js';
export type { FormattedResult } from './format-results.js';

// Handler factories (REMOTE tools — require ToolDeps)
export { createSearchToolsHandler } from './handlers/search-tools.js';
export { createSearchToolsRespondHandler } from './handlers/search-tools-respond.js';
export { createCheckCompatibilityHandler } from './handlers/check-compatibility.js';
export { createCompareToolsHandler } from './handlers/compare-tools.js';
export { createGetStackHandler } from './handlers/get-stack.js';
export { createRefineRequirementHandler } from './handlers/refine-requirement.js';
export { createCheckIssueHandler } from './handlers/check-issue.js';
export { createReportOutcomeHandler } from './handlers/report-outcome.js';
export { createSuggestGraphUpdateHandler } from './handlers/suggest-graph-update.js';
export { createVerifySuggestionHandler } from './handlers/verify-suggestion.js';

// Standalone handlers (LOCAL tools — no deps)
export { handleClassifyPrompt } from './handlers/classify-prompt.js';
export { handleToolpilotInit } from './handlers/toolpilot-init.js';
export { handleInitProjectConfig } from './handlers/init-project-config.js';
export { handleReadProjectConfig } from './handlers/read-project-config.js';
export { handleUpdateProjectConfig } from './handlers/update-project-config.js';

import { createCheckCompatibilityHandler } from './handlers/check-compatibility.js';
import { createCheckIssueHandler } from './handlers/check-issue.js';
import { handleClassifyPrompt } from './handlers/classify-prompt.js';
import { createCompareToolsHandler } from './handlers/compare-tools.js';
import { createGetStackHandler } from './handlers/get-stack.js';
import { handleInitProjectConfig } from './handlers/init-project-config.js';
import { handleReadProjectConfig } from './handlers/read-project-config.js';
import { createRefineRequirementHandler } from './handlers/refine-requirement.js';
import { createReportOutcomeHandler } from './handlers/report-outcome.js';
import { createSearchToolsRespondHandler } from './handlers/search-tools-respond.js';
import { createSearchToolsHandler } from './handlers/search-tools.js';
import { createSuggestGraphUpdateHandler } from './handlers/suggest-graph-update.js';
import { handleToolpilotInit } from './handlers/toolpilot-init.js';
import { handleUpdateProjectConfig } from './handlers/update-project-config.js';
import { createVerifySuggestionHandler } from './handlers/verify-suggestion.js';
import type { ToolDeps } from './types.js';

/**
 * Convenience function: create all handlers from a single ToolDeps instance.
 * Both apps/mcp-server (dev mode) and apps/api (production) call this.
 */
export function createAllHandlers(deps: ToolDeps) {
  return {
    // REMOTE — require deps
    handleSearchTools: createSearchToolsHandler(deps),
    handleSearchToolsRespond: createSearchToolsRespondHandler(deps),
    handleCheckCompatibility: createCheckCompatibilityHandler(deps),
    handleCompareTools: createCompareToolsHandler(deps),
    handleGetStack: createGetStackHandler(deps),
    handleRefineRequirement: createRefineRequirementHandler(deps),
    handleCheckIssue: createCheckIssueHandler(deps),
    handleReportOutcome: createReportOutcomeHandler(deps),
    handleSuggestGraphUpdate: createSuggestGraphUpdateHandler(deps),
    handleVerifySuggestion: createVerifySuggestionHandler(deps),
    // LOCAL — no deps
    handleClassifyPrompt,
    handleToolpilotInit,
    handleInitProjectConfig,
    handleReadProjectConfig,
    handleUpdateProjectConfig,
  };
}

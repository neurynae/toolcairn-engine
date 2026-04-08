/**
 * Production-safe subpath export — no DB/search/graph dependencies.
 *
 * Import from '@toolcairn/tools/local' (not '@toolcairn/tools') when you need
 * only the local/standalone handlers and schemas without pulling in Prisma,
 * neo4j-driver, ioredis, etc. Used by the npm-published MCP server bundle.
 */

// Zod input schemas (used by both local and remote tools)
export * from './schemas.js';

// Type utilities
export { okResult, errResult } from './utils.js';
export type { FormattedResult } from './format-results.js';

// Local handlers — run entirely on the user's machine, zero DB deps
export { handleClassifyPrompt } from './handlers/classify-prompt.js';
export { handleToolpilotInit } from './handlers/toolpilot-init.js';
export { handleInitProjectConfig } from './handlers/init-project-config.js';
export { handleReadProjectConfig } from './handlers/read-project-config.js';
export { handleUpdateProjectConfig } from './handlers/update-project-config.js';

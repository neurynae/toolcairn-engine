/**
 * Factory that creates a ToolDeps instance from the current environment config.
 * Both apps/mcp-server (dev mode) and apps/api (production) call this on startup.
 */
import { PrismaClient } from '@toolcairn/db';
import { MemgraphToolRepository, MemgraphUseCaseRepository } from '@toolcairn/graph';
import { enqueueIndexJob, enqueueSearchEvent } from '@toolcairn/queue';
import { ClarificationEngine, SearchPipeline, SearchSessionManager } from '@toolcairn/search';
import type { ToolDeps } from './types.js';

export function createDeps(): ToolDeps {
  const prisma = new PrismaClient();
  const sessionManager = new SearchSessionManager(prisma);
  const pipeline = new SearchPipeline(sessionManager);

  return {
    graphRepo: new MemgraphToolRepository(),
    usecaseRepo: new MemgraphUseCaseRepository(),
    prisma,
    enqueueIndexJob,
    enqueueSearchEvent,
    pipeline,
    sessionManager,
    clarificationEngine: new ClarificationEngine(),
  };
}

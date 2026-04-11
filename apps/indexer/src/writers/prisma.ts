import { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { IndexerError } from '../errors.js';

const logger = createLogger({ name: '@toolcairn/indexer:prisma-writer' });

let _prisma: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Can't reach database") ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('connection')
  );
}

async function withReconnect<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  try {
    return await fn(getPrismaClient());
  } catch (err) {
    if (isConnectionError(err)) {
      logger.warn('Prisma connection lost — reconnecting');
      try {
        await _prisma?.$disconnect();
      } catch {
        /* ignore */
      }
      _prisma = new PrismaClient();
      await _prisma.$connect();
      return fn(_prisma);
    }
    throw err;
  }
}

/**
 * Upsert an IndexedTool record in PostgreSQL.
 * Sets graph_node_id, last_indexed_at, index_status, and increments retry_count.
 */
export async function upsertIndexedTool(
  githubUrl: string,
  graphNodeId: string,
  status: string,
): Promise<void> {
  try {
    await withReconnect((prisma) =>
      prisma.indexedTool.upsert({
        where: { github_url: githubUrl },
        update: {
          graph_node_id: graphNodeId,
          last_indexed_at: new Date(),
          index_status: status,
          retry_count: { increment: 1 },
          updated_at: new Date(),
        },
        create: {
          github_url: githubUrl,
          graph_node_id: graphNodeId,
          last_indexed_at: new Date(),
          index_status: status,
          retry_count: 0,
        },
      }),
    );
    logger.info({ githubUrl, graphNodeId, status }, 'IndexedTool upserted in PostgreSQL');
  } catch (e) {
    throw new IndexerError({
      message: `Failed to upsert IndexedTool for ${githubUrl}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

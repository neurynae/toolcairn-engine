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

export interface IndexedToolMeta {
  /** Star count at evaluation time */
  stars?: number;
  /** Weekly download count at evaluation time */
  weeklyDownloads?: number;
  /** Why the tool was skipped — only set on skipped tools */
  skipReason?: string;
}

/**
 * Upsert an IndexedTool record in PostgreSQL.
 * Sets graph_node_id, last_indexed_at, index_status, and increments retry_count.
 * Optionally stores quality signals (stars, downloads, skip reason, registry info).
 */
export async function upsertIndexedTool(
  githubUrl: string,
  graphNodeId: string,
  status: string,
  meta?: IndexedToolMeta,
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
          ...(meta?.stars !== undefined && { stars: meta.stars }),
          ...(meta?.weeklyDownloads !== undefined && { weekly_downloads: meta.weeklyDownloads }),
          ...(meta?.skipReason !== undefined && { skip_reason: meta.skipReason }),
        },
        create: {
          github_url: githubUrl,
          graph_node_id: graphNodeId,
          last_indexed_at: new Date(),
          index_status: status,
          retry_count: 0,
          stars: meta?.stars,
          weekly_downloads: meta?.weeklyDownloads,
          skip_reason: meta?.skipReason,
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

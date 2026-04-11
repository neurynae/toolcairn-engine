import { config } from '@toolcairn/config';
import { ensureAllCollections } from '@toolcairn/vector';
import { Redis } from 'ioredis';
import { createLogger } from '@toolcairn/errors';
import { createProdLogger } from '@toolcairn/errors/transports';
import { startIndexWorker } from './workers/index-worker.js';

const logger =
  process.env.NODE_ENV === 'production'
    ? createProdLogger({ name: '@toolcairn/indexer' })
    : createLogger({ name: '@toolcairn/indexer' });

const LOCK_KEY = 'toolpilot:indexer:lock';
const LOCK_TTL_SEC = 3600; // 1 hour — auto-expires if the process crashes

/**
 * Acquire a Redis-based mutex lock so only ONE indexer instance runs at a time.
 * Returns the Redis client (to release lock on exit) or exits the process if
 * another instance already holds the lock.
 */
async function acquireLock(): Promise<Redis> {
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, connectTimeout: 5000 });
  await redis.connect();

  const lockValue = `pid:${process.pid}`;
  const acquired = await redis.set(LOCK_KEY, lockValue, 'EX', LOCK_TTL_SEC, 'NX');

  if (!acquired) {
    const holder = await redis.get(LOCK_KEY);
    // In Docker, the previous container's PID is gone — steal the lock if it's stale
    const holderPid = holder?.replace('pid:', '');
    const isDockerRestart = !holderPid || holderPid === '1';
    if (isDockerRestart) {
      await redis.set(LOCK_KEY, lockValue, 'EX', LOCK_TTL_SEC);
      logger.info({ lockValue, previousHolder: holder }, 'Stale lock detected — took over');
    } else {
      logger.warn({ holder }, 'Another indexer instance is already running — exiting');
      await redis.disconnect();
      process.exit(0);
    }
  }

  logger.info({ lockValue, ttlSec: LOCK_TTL_SEC }, 'Indexer lock acquired');
  return redis;
}

async function releaseLock(redis: Redis): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
    await redis.disconnect();
    logger.info('Indexer lock released');
  } catch {
    // ignore — TTL will clean it up anyway
  }
}

async function main(): Promise<void> {
  logger.info('ToolPilot Indexer starting');

  const lockRedis = await acquireLock();

  // Release lock on any exit signal
  const cleanup = () => releaseLock(lockRedis);
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);

  try {
    await ensureAllCollections();
    logger.info('Qdrant collections ready');
    await startIndexWorker();
  } finally {
    await cleanup();
    process.off('SIGTERM', cleanup);
    process.off('SIGINT', cleanup);
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Indexer failed to start');
  process.exit(1);
});

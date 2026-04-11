import { config } from '@toolcairn/config';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/graph:client' });

let driver: Driver | null = null;

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export function getMemgraphDriver(): Driver {
  if (driver !== null) {
    return driver;
  }

  const uri = config.MEMGRAPH_URL;
  const username = config.MEMGRAPH_USER;
  const password = config.MEMGRAPH_PASSWORD;

  driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30_000,
  });

  logger.info({ uri }, 'Memgraph driver created');
  return driver;
}

export function getMemgraphSession(): Session {
  return getMemgraphDriver().session();
}

export async function closeMemgraphDriver(): Promise<void> {
  if (driver !== null) {
    await driver.close();
    driver = null;
    logger.info('Memgraph driver closed');
  }
}

export async function memgraphHealthCheck(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const session = getMemgraphSession();
    await session.run('RETURN 1');
    await session.close();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Memgraph health check failed');
    return { ok: false, error };
  }
}

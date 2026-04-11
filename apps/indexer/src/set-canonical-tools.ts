/**
 * Set is_canonical = true for definitively canonical tools.
 *
 * Canonical tools bypass the Stage 0 credibility gate (MIN_CRED = 0.7),
 * ensuring that well-known tools like facebook/react always resolve
 * correctly even if credibility data is temporarily stale/corrupted.
 *
 * Maintain this list carefully — only add tools that are unambiguously
 * THE canonical tool for their name in the developer ecosystem.
 *
 * Usage: pnpm tsx src/set-canonical-tools.ts
 */

import { createLogger } from '@toolcairn/errors';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:set-canonical-tools' });

/** owner/repo → canonical tool name (as stored in Memgraph/Qdrant) */
const CANONICAL_TOOLS: Array<{ githubUrl: string; name: string }> = [
  // JavaScript / TypeScript ecosystem
  { githubUrl: 'https://github.com/facebook/react', name: 'react' },
  { githubUrl: 'https://github.com/vitejs/vite', name: 'vite' },
  { githubUrl: 'https://github.com/vercel/next.js', name: 'next.js' },
  { githubUrl: 'https://github.com/expressjs/express', name: 'express' },
  { githubUrl: 'https://github.com/colinhacks/zod', name: 'zod' },
  { githubUrl: 'https://github.com/prisma/prisma', name: 'prisma' },
  { githubUrl: 'https://github.com/tailwindlabs/tailwindcss', name: 'tailwindcss' },
  { githubUrl: 'https://github.com/vuejs/core', name: 'vue' },
  { githubUrl: 'https://github.com/sveltejs/svelte', name: 'svelte' },
  { githubUrl: 'https://github.com/angular/angular', name: 'angular' },
  { githubUrl: 'https://github.com/nestjs/nest', name: 'nest' },
  { githubUrl: 'https://github.com/fastify/fastify', name: 'fastify' },
  { githubUrl: 'https://github.com/koajs/koa', name: 'koa' },
  { githubUrl: 'https://github.com/axios/axios', name: 'axios' },
  { githubUrl: 'https://github.com/jestjs/jest', name: 'jest' },
  { githubUrl: 'https://github.com/vitest-dev/vitest', name: 'vitest' },
  { githubUrl: 'https://github.com/webpack/webpack', name: 'webpack' },
  { githubUrl: 'https://github.com/evanw/esbuild', name: 'esbuild' },
  { githubUrl: 'https://github.com/reduxjs/redux', name: 'redux' },
  { githubUrl: 'https://github.com/pmndrs/zustand', name: 'zustand' },
  { githubUrl: 'https://github.com/TanStack/query', name: 'react-query' },
  { githubUrl: 'https://github.com/drizzle-team/drizzle-orm', name: 'drizzle-orm' },
  { githubUrl: 'https://github.com/typeorm/typeorm', name: 'typeorm' },
  { githubUrl: 'https://github.com/sequelize/sequelize', name: 'sequelize' },
  { githubUrl: 'https://github.com/graphql/graphql-js', name: 'graphql' },
  { githubUrl: 'https://github.com/apollographql/apollo-client', name: 'apollo-client' },
  { githubUrl: 'https://github.com/socketio/socket.io', name: 'socket.io' },
  { githubUrl: 'https://github.com/vercel/ai', name: 'ai' },
  { githubUrl: 'https://github.com/microsoft/playwright', name: 'playwright' },
  { githubUrl: 'https://github.com/cypress-io/cypress', name: 'cypress' },
  // Python ecosystem
  { githubUrl: 'https://github.com/django/django', name: 'django' },
  { githubUrl: 'https://github.com/tiangolo/fastapi', name: 'fastapi' },
  { githubUrl: 'https://github.com/pallets/flask', name: 'flask' },
  { githubUrl: 'https://github.com/sqlalchemy/sqlalchemy', name: 'sqlalchemy' },
  { githubUrl: 'https://github.com/pydantic/pydantic', name: 'pydantic' },
  { githubUrl: 'https://github.com/celery/celery', name: 'celery' },
  { githubUrl: 'https://github.com/pytest-dev/pytest', name: 'pytest' },
  { githubUrl: 'https://github.com/numpy/numpy', name: 'numpy' },
  { githubUrl: 'https://github.com/pandas-dev/pandas', name: 'pandas' },
  { githubUrl: 'https://github.com/langchain-ai/langchain', name: 'langchain' },
  // Rust ecosystem
  { githubUrl: 'https://github.com/actix/actix-web', name: 'actix-web' },
  { githubUrl: 'https://github.com/tokio-rs/axum', name: 'axum' },
  { githubUrl: 'https://github.com/serde-rs/serde', name: 'serde' },
  { githubUrl: 'https://github.com/tokio-rs/tokio', name: 'tokio' },
  // Go ecosystem
  { githubUrl: 'https://github.com/gin-gonic/gin', name: 'gin' },
  { githubUrl: 'https://github.com/gofiber/fiber', name: 'fiber' },
  // Databases / Infrastructure
  { githubUrl: 'https://github.com/redis/redis', name: 'redis' },
  { githubUrl: 'https://github.com/mongodb/mongo', name: 'mongo' },
  { githubUrl: 'https://github.com/qdrant/qdrant', name: 'qdrant' },
  { githubUrl: 'https://github.com/docker/docker-ce', name: 'docker' },
  { githubUrl: 'https://github.com/kubernetes/kubernetes', name: 'kubernetes' },
];

async function main() {
  const session = getMemgraphSession();
  const client = qdrantClient();
  let setCount = 0;

  try {
    for (const { githubUrl, name } of CANONICAL_TOOLS) {
      // Update Memgraph by github_url (unique per tool)
      const memResult = await session.run(
        'MATCH (t:Tool {github_url: $url}) SET t.is_canonical = true RETURN count(t) AS n',
        { url: githubUrl },
      );
      const n = memResult.records[0]?.get('n') ?? 0;

      // Update Qdrant payload by name (multiple tools may share a name — update all)
      const scrollResult = await client.scroll(COLLECTION_NAME, {
        filter: { must: [{ key: 'name', match: { value: name } }] },
        limit: 10,
        with_payload: false,
        with_vector: false,
      });

      for (const point of scrollResult.points as Array<{ id: string | number }>) {
        await client.setPayload(COLLECTION_NAME, {
          payload: { is_canonical: true },
          points: [String(point.id)],
        });
      }

      if (n > 0 || scrollResult.points.length > 0) {
        logger.info(
          { name, githubUrl, memgraph: n, qdrant: scrollResult.points.length },
          'Set canonical',
        );
        setCount++;
      } else {
        logger.warn({ name, githubUrl }, 'Tool not found in DB — skipping');
      }
    }

    logger.info({ setCount, total: CANONICAL_TOOLS.length }, 'Canonical flag assignment complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

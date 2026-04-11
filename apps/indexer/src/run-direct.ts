/**
 * Direct indexer — runs a fixed list of tools without going through the Redis queue.
 * Usage: tsx src/run-direct.ts
 * Requires: MEMGRAPH_URL, DATABASE_URL set in env.
 * NOMIC_API_KEY optional (vector skipped if absent).
 * GITHUB_TOKEN required for >2 tools (unauthenticated = 60 req/hr).
 */
import { createLogger } from '@toolcairn/errors';
import { handleIndexJob } from './queue-consumers/index-consumer.js';

const logger = createLogger({ name: '@toolcairn/indexer:run-direct' });

// Original 20 seed tools
const SEED_TOOLS = [
  'colinhacks/zod',
  'honojs/hono',
  'biomejs/biome',
  'vitest-dev/vitest',
  'redis/ioredis',
  'vercel/next.js',
  'vitejs/vite',
  'prisma/prisma',
  'trpc/trpc',
  'redwoodjs/redwood',
  'remix-run/remix',
  'sveltejs/svelte',
  'vuejs/vue',
  'angular/angular',
  'nestjs/nest',
  'fastify/fastify',
  'expressjs/express',
  'drizzle-team/drizzle-orm',
  'qdrant/qdrant-js',
  'memgraph/memgraph',
];

// 100 additional tools across the ecosystem
const EXTRA_TOOLS = [
  // Web frameworks
  'solidjs/solid',
  'preactjs/preact',
  'alpinejs/alpine',
  'astro-build/astro',
  'nuxt/nuxt',
  'elysiajs/elysia',
  'sveltejs/kit',
  'koajs/koa',
  'hapijs/hapi',
  'denoland/fresh',

  // React ecosystem
  'facebook/react',
  'vercel/swr',
  'tanstack/query',
  'tanstack/router',
  'tanstack/table',
  'tanstack/form',
  'tanstack/virtual',
  'pmndrs/react-three-fiber',

  // Testing
  'jestjs/jest',
  'cypress-io/cypress',
  'microsoft/playwright',
  'mochajs/mocha',
  'storybookjs/storybook',
  'mswjs/msw',
  'avajs/ava',
  'testing-library/react-testing-library',

  // Database / ORM
  'typeorm/typeorm',
  'sequelize/sequelize',
  'mikro-orm/mikro-orm',
  'kysely-org/kysely',
  'knex/knex',
  'mongodb/node-mongodb-native',
  'payloadcms/payload',
  'keystonejs/keystone',

  // Auth
  'nextauthjs/next-auth',
  'lucia-auth/lucia',
  'panva/jose',
  'auth0/node-auth0',
  'supabase/supabase-js',

  // State management
  'reduxjs/redux',
  'pmndrs/zustand',
  'pmndrs/jotai',
  'mobxjs/mobx',
  'vuejs/pinia',

  // UI / CSS
  'tailwindlabs/tailwindcss',
  'radix-ui/primitives',
  'chakra-ui/chakra-ui',
  'ant-design/ant-design',
  'mui/material-ui',
  'mantine-dev/mantine',
  'ionic-team/ionic-framework',

  // Build tools
  'rollup/rollup',
  'parcel-bundler/parcel',
  'evanw/esbuild',
  'swc-project/swc',
  'babel/babel',
  'webpack/webpack',
  'oven-sh/bun',

  // HTTP clients
  'axios/axios',
  'sindresorhus/got',
  'node-fetch/node-fetch',
  'unjs/ofetch',
  'visionmedia/superagent',

  // GraphQL
  'apollographql/apollo-client',
  'apollographql/apollo-server',
  'the-guild-dev/graphql-yoga',
  'graphql/graphql-js',

  // Validation
  'hapijs/joi',
  'jquense/yup',
  'fabian-hiller/valibot',
  'ianstormtaylor/superstruct',

  // Documentation
  'facebook/docusaurus',
  'vuejs/vitepress',
  'withastro/starlight',

  // Monitoring / Observability
  'open-telemetry/opentelemetry-js',
  'getsentry/sentry-javascript',
  'DataDog/dd-trace-js',

  // AI / LLM
  'langchain-ai/langchainjs',
  'vercel/ai',
  'openai/openai-node',
  'microsoft/autogen',

  // Monorepo
  'nrwl/nx',
  'vercel/turbo',
  'lerna/lerna',
  'changesets/changesets',

  // CMS / BaaS
  'strapi/strapi',
  'directus/directus',
  'supabase/supabase',

  // Realtime
  'socketio/socket.io',
  'websockets/ws',

  // Utilities
  'lodash/lodash',
  'date-fns/date-fns',
  'iamkun/dayjs',
  'pinojs/pino',
  'winstonjs/winston',
  'motdotla/dotenv',
  'caolan/async',

  // UnJS ecosystem
  'unjs/h3',
  'unjs/nitro',
  'unjs/unstorage',
];

// Skip repos already indexed in a prior run (by their Memgraph name)
const SKIP_EXISTING = new Set(SEED_TOOLS);

async function main(): Promise<void> {
  const tools = [...SEED_TOOLS, ...EXTRA_TOOLS];
  logger.info({ total: tools.length }, 'Starting direct indexer run');

  for (const tool of tools) {
    // Already indexed if in seed list and this is an incremental run
    if (SKIP_EXISTING.has(tool) && process.env.SKIP_SEED === '1') {
      logger.debug({ tool }, 'Skipping already-indexed seed tool');
      continue;
    }
    logger.info({ tool }, 'Indexing tool');
    await handleIndexJob(tool, 1);
  }

  logger.info('Direct indexer run complete');
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Direct indexer run failed');
  process.exit(1);
});

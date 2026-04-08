/**
 * Indexes all tools not yet in Memgraph from the full 120-tool list.
 * Run with: pnpm --filter @toolcairn/indexer exec tsx src/run-remaining.ts
 */
import pino from 'pino';
import { handleIndexJob } from './queue-consumers/index-consumer.js';

const logger = pino({ name: '@toolcairn/indexer:run-remaining' });

const REMAINING_TOOLS = [
  // Missed from seed / extra-tools run
  'redwoodjs/redwood',
  'astro-build/astro',

  // Database / ORM (from kysely-org/kysely onwards)
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

  // Monitoring
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

  // UnJS
  'unjs/h3',
  'unjs/nitro',
  'unjs/unstorage',
];

async function main(): Promise<void> {
  logger.info({ count: REMAINING_TOOLS.length }, 'Starting remaining-tools indexer run');
  for (const tool of REMAINING_TOOLS) {
    logger.info({ tool }, 'Indexing tool');
    await handleIndexJob(tool, 1);
  }
  logger.info('Remaining-tools indexer run complete');
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Remaining-tools indexer run failed');
  process.exit(1);
});

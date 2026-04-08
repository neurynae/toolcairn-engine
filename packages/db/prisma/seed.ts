/**
 * Seed script — pre-populates IndexedTool with canonical developer tools across
 * every major software domain so search has a solid baseline immediately,
 * independent of discovery scheduler runs.
 *
 * Tools are enqueued as 'pending'. The indexer processes them into Memgraph +
 * Qdrant + PostgreSQL. Run with: pnpm db:seed
 *
 * Rules:
 *   - Real, active GitHub repos only
 *   - >500 stars preferred (signal-to-noise)
 *   - One canonical repo per tool (no forks/mirrors)
 *   - Cover ALL domains — not just AI/web
 *   - This list is idempotent (skip existing)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_TOOLS: string[] = [
  // ── AI / LLM Frameworks ──────────────────────────────────────────────────
  'https://github.com/langchain-ai/langchainjs',
  'https://github.com/run-llama/LlamaIndex.TS',
  'https://github.com/microsoft/semantic-kernel',
  'https://github.com/vercel/ai',
  'https://github.com/huggingface/transformers',
  'https://github.com/openai/openai-node',
  'https://github.com/anthropics/anthropic-sdk-python',
  'https://github.com/ollama/ollama',
  'https://github.com/ggerganov/llama.cpp',
  'https://github.com/mudler/LocalAI',
  'https://github.com/BerriAI/litellm',
  'https://github.com/deepseek-ai/DeepSeek-Coder',
  'https://github.com/mistralai/mistral-common',
  'https://github.com/oobabooga/text-generation-webui',
  'https://github.com/open-webui/open-webui',

  // ── LLM Ops / Evaluation ──────────────────────────────────────────────────
  'https://github.com/Arize-ai/phoenix',
  'https://github.com/langfuse/langfuse',
  'https://github.com/Helicone/helicone',
  'https://github.com/traceloop/openllmetry',
  'https://github.com/promptfoo/promptfoo',

  // ── Vector / Embedding Databases ─────────────────────────────────────────
  'https://github.com/qdrant/qdrant',
  'https://github.com/chroma-core/chroma',
  'https://github.com/weaviate/weaviate',
  'https://github.com/milvus-io/milvus',
  'https://github.com/pgvector/pgvector',
  'https://github.com/turbopuffer/turbopuffer',
  'https://github.com/lancedb/lancedb',

  // ── MCP / Agent Tooling ────────────────────────────────────────────────────
  'https://github.com/modelcontextprotocol/servers',
  'https://github.com/pydantic/pydantic-ai',
  'https://github.com/microsoft/autogen',
  'https://github.com/crewAIInc/crewAI',
  'https://github.com/langgenius/dify',
  'https://github.com/FlowiseAI/Flowise',
  'https://github.com/n8n-io/n8n',
  'https://github.com/Significant-Gravitas/AutoGPT',
  'https://github.com/smol-ai/developer',

  // ── Web Frameworks (Node.js / Bun / Deno) ────────────────────────────────
  'https://github.com/expressjs/express',
  'https://github.com/fastify/fastify',
  'https://github.com/nestjs/nest',
  'https://github.com/honojs/hono',
  'https://github.com/koajs/koa',
  'https://github.com/adonisjs/core',
  'https://github.com/elysiajs/elysia',
  'https://github.com/denoland/deno',
  'https://github.com/oven-sh/bun',
  'https://github.com/trpc/trpc',

  // ── Web Frameworks (Python) ───────────────────────────────────────────────
  'https://github.com/django/django',
  'https://github.com/pallets/flask',
  'https://github.com/fastapi/fastapi',
  'https://github.com/encode/starlette',
  'https://github.com/aio-libs/aiohttp',
  'https://github.com/tiangolo/litestar',
  'https://github.com/sanic-org/sanic',

  // ── Web Frameworks (Go) ───────────────────────────────────────────────────
  'https://github.com/gin-gonic/gin',
  'https://github.com/labstack/echo',
  'https://github.com/gofiber/fiber',
  'https://github.com/go-chi/chi',
  'https://github.com/beego/beego',

  // ── Web Frameworks (Rust) ─────────────────────────────────────────────────
  'https://github.com/tokio-rs/axum',
  'https://github.com/actix/actix-web',
  'https://github.com/SergioBenitez/Rocket',

  // ── Web Frameworks (Java/Kotlin/Scala) ────────────────────────────────────
  'https://github.com/spring-projects/spring-boot',
  'https://github.com/quarkusio/quarkus',
  'https://github.com/ktorio/ktor',
  'https://github.com/micronaut-projects/micronaut-core',

  // ── Web Frameworks (Ruby/PHP/Elixir) ──────────────────────────────────────
  'https://github.com/rails/rails',
  'https://github.com/sinatra/sinatra',
  'https://github.com/laravel/laravel',
  'https://github.com/symfony/symfony',
  'https://github.com/phoenixframework/phoenix',

  // ── Frontend Frameworks ───────────────────────────────────────────────────
  'https://github.com/facebook/react',
  'https://github.com/vuejs/core',
  'https://github.com/angular/angular',
  'https://github.com/sveltejs/svelte',
  'https://github.com/solidjs/solid',
  'https://github.com/preactjs/preact',
  'https://github.com/alpinejs/alpine',
  'https://github.com/BuilderIO/qwik',
  'https://github.com/marko-js/marko',
  'https://github.com/bigskysoftware/htmx',

  // ── Meta-frameworks ───────────────────────────────────────────────────────
  'https://github.com/vercel/next.js',
  'https://github.com/nuxt/nuxt',
  'https://github.com/withastro/astro',
  'https://github.com/remix-run/remix',
  'https://github.com/sveltejs/kit',
  'https://github.com/redwoodjs/redwood',
  'https://github.com/TanStack/router',
  'https://github.com/blitz-js/blitz',

  // ── CSS / Styling ─────────────────────────────────────────────────────────
  'https://github.com/tailwindlabs/tailwindcss',
  'https://github.com/sass/sass',
  'https://github.com/postcss/postcss',
  'https://github.com/styled-components/styled-components',
  'https://github.com/emotion-js/emotion',
  'https://github.com/vanilla-extract-css/vanilla-extract',
  'https://github.com/twbs/bootstrap',
  'https://github.com/jgthms/bulma',
  'https://github.com/ant-design/ant-design',
  'https://github.com/mui/material-ui',
  'https://github.com/mantinedev/mantine',
  'https://github.com/radix-ui/primitives',
  'https://github.com/shadcn-ui/ui',
  'https://github.com/daisyui/daisyui',
  'https://github.com/unocss/unocss',

  // ── Animation ─────────────────────────────────────────────────────────────
  'https://github.com/framer/motion',
  'https://github.com/greensock/GSAP',
  'https://github.com/pmndrs/react-spring',
  'https://github.com/theatre-js/theatre',

  // ── UI Components / Storybook ─────────────────────────────────────────────
  'https://github.com/storybookjs/storybook',
  'https://github.com/floating-ui/floating-ui',
  'https://github.com/ariakit/ariakit',

  // ── Static Site Generators ────────────────────────────────────────────────
  'https://github.com/gohugoio/hugo',
  'https://github.com/jekyll/jekyll',
  'https://github.com/11ty/eleventy',
  'https://github.com/gatsbyjs/gatsby',
  'https://github.com/hexojs/hexo',
  'https://github.com/facebook/docusaurus',
  'https://github.com/vuejs/vitepress',
  'https://github.com/mkdocs/mkdocs',
  'https://github.com/squidfunk/mkdocs-material',

  // ── CMS / Headless CMS ────────────────────────────────────────────────────
  'https://github.com/payloadcms/payload',
  'https://github.com/directus/directus',
  'https://github.com/TryGhost/Ghost',
  'https://github.com/strapi/strapi',
  'https://github.com/sanity-io/sanity',
  'https://github.com/keystonejs/keystone',
  'https://github.com/WordPress/WordPress',

  // ── Testing ───────────────────────────────────────────────────────────────
  'https://github.com/jestjs/jest',
  'https://github.com/vitest-dev/vitest',
  'https://github.com/microsoft/playwright',
  'https://github.com/cypress-io/cypress',
  'https://github.com/mochajs/mocha',
  'https://github.com/avajs/ava',
  'https://github.com/jasmine/jasmine',
  'https://github.com/puppeteer/puppeteer',
  'https://github.com/SeleniumHQ/selenium',
  'https://github.com/webdriverio/webdriverio',
  'https://github.com/pytest-dev/pytest',
  'https://github.com/HypothesisWorks/hypothesis',
  'https://github.com/testcontainers/testcontainers-node',
  'https://github.com/grafana/k6',
  'https://github.com/locustio/locust',
  'https://github.com/artilleryio/artillery',
  'https://github.com/mswjs/msw',
  'https://github.com/nock/nock',
  'https://github.com/sinonjs/sinon',
  'https://github.com/faker-js/faker',

  // ── Databases (Relational) ────────────────────────────────────────────────
  'https://github.com/postgres/postgres',
  'https://github.com/mysql/mysql-server',
  'https://github.com/sqlite/sqlite',
  'https://github.com/cockroachdb/cockroach',
  'https://github.com/duckdb/duckdb',
  'https://github.com/pingcap/tidb',
  'https://github.com/MariaDB/server',

  // ── Databases (Document / Key-Value) ────────────────────────────────────────
  'https://github.com/mongodb/mongo',
  'https://github.com/redis/redis',
  'https://github.com/apache/cassandra',
  'https://github.com/couchbase/couchbase-lite-core',
  'https://github.com/valkey-io/valkey',

  // ── Databases (Time-series / Analytics) ────────────────────────────────────
  'https://github.com/influxdata/influxdb',
  'https://github.com/ClickHouse/ClickHouse',
  'https://github.com/questdb/questdb',
  'https://github.com/apache/druid',
  'https://github.com/StarRocks/starrocks',

  // ── Graph Databases ───────────────────────────────────────────────────────
  'https://github.com/memgraph/memgraph',
  'https://github.com/neo4j/neo4j',
  'https://github.com/JanusGraph/janusgraph',

  // ── ORMs & Query Builders ─────────────────────────────────────────────────
  'https://github.com/prisma/prisma',
  'https://github.com/drizzle-team/drizzle-orm',
  'https://github.com/typeorm/typeorm',
  'https://github.com/sequelize/sequelize',
  'https://github.com/knex/knex',
  'https://github.com/mikro-orm/mikro-orm',
  'https://github.com/sqlalchemy/sqlalchemy',
  'https://github.com/go-gorm/gorm',
  'https://github.com/jmoiron/sqlx',
  'https://github.com/diesel-rs/diesel',

  // ── Search Engines ────────────────────────────────────────────────────────
  'https://github.com/meilisearch/meilisearch',
  'https://github.com/typesense/typesense',
  'https://github.com/elastic/elasticsearch',
  'https://github.com/opensearch-project/OpenSearch',
  'https://github.com/zincsearch/zincsearch',
  'https://github.com/quickwit-oss/quickwit',

  // ── Caching ───────────────────────────────────────────────────────────────
  'https://github.com/redis/ioredis',
  'https://github.com/redis/node-redis',
  'https://github.com/memcached/memcached',
  'https://github.com/ben-manes/caffeine',
  'https://github.com/jaredwray/keyv',

  // ── Authentication & Identity ─────────────────────────────────────────────
  'https://github.com/jaredhanson/passport',
  'https://github.com/nextauthjs/next-auth',
  'https://github.com/lucia-auth/lucia',
  'https://github.com/better-auth/better-auth',
  'https://github.com/panva/jose',
  'https://github.com/auth0/node-auth0',
  'https://github.com/keycloak/keycloak',
  'https://github.com/ory/hydra',
  'https://github.com/ory/kratos',
  'https://github.com/supertokens/supertokens-core',
  'https://github.com/clerkinc/javascript',

  // ── Security ──────────────────────────────────────────────────────────────
  'https://github.com/nicowillis/owasp-top10',
  'https://github.com/OWASP/wstg',
  'https://github.com/projectdiscovery/nuclei',
  'https://github.com/ffuf/ffuf',
  'https://github.com/sqlmapproject/sqlmap',
  'https://github.com/aquasecurity/trivy',

  // ── Build Tools & Bundlers ────────────────────────────────────────────────
  'https://github.com/vitejs/vite',
  'https://github.com/webpack/webpack',
  'https://github.com/rollup/rollup',
  'https://github.com/evanw/esbuild',
  'https://github.com/parcel-bundler/parcel',
  'https://github.com/swc-project/swc',
  'https://github.com/babel/babel',
  'https://github.com/microsoft/TypeScript',
  'https://github.com/rome/tools',
  'https://github.com/nicolo-ribaudo/oxc-project',
  'https://github.com/oxc-project/oxc',
  'https://github.com/nicolo-ribaudo/rspack',
  'https://github.com/web-infra-dev/rspack',
  'https://github.com/nicolo-ribaudo/farm-fe',
  'https://github.com/farm-fe/farm',
  'https://github.com/privatenumber/tsx',
  'https://github.com/nicolo-ribaudo/tsup',
  'https://github.com/nicolo-ribaudo/unbuild',

  // ── Linting, Formatting, Code Quality ─────────────────────────────────────
  'https://github.com/eslint/eslint',
  'https://github.com/prettier/prettier',
  'https://github.com/biomejs/biome',
  'https://github.com/oxc-project/oxc',
  'https://github.com/astral-sh/ruff',
  'https://github.com/psf/black',
  'https://github.com/PyCQA/flake8',
  'https://github.com/PyCQA/isort',
  'https://github.com/pylint-dev/pylint',
  'https://github.com/nicolo-ribaudo/mypy',
  'https://github.com/python/mypy',
  'https://github.com/golangci/golangci-lint',

  // ── Package Managers / Monorepo ───────────────────────────────────────────
  'https://github.com/pnpm/pnpm',
  'https://github.com/yarnpkg/berry',
  'https://github.com/npm/cli',
  'https://github.com/vercel/turborepo',
  'https://github.com/nrwl/nx',
  'https://github.com/lerna/lerna',
  'https://github.com/changesets/changesets',
  'https://github.com/nicolo-ribaudo/moon',
  'https://github.com/moonrepo/moon',
  'https://github.com/astral-sh/uv',
  'https://github.com/python-poetry/poetry',

  // ── CLI Tooling ───────────────────────────────────────────────────────────
  'https://github.com/tj/commander.js',
  'https://github.com/yargs/yargs',
  'https://github.com/oclif/oclif',
  'https://github.com/chalk/chalk',
  'https://github.com/SBoudrias/Inquirer.js',
  'https://github.com/sindresorhus/ora',
  'https://github.com/sindresorhus/execa',
  'https://github.com/google/zx',
  'https://github.com/BurntSushi/ripgrep',
  'https://github.com/sharkdp/fd',
  'https://github.com/sharkdp/bat',
  'https://github.com/cli/cli',
  'https://github.com/charmbracelet/bubbletea',
  'https://github.com/nicolo-ribaudo/cobra',
  'https://github.com/spf13/cobra',
  'https://github.com/clap-rs/clap',
  'https://github.com/nicolo-ribaudo/click',
  'https://github.com/pallets/click',

  // ── Editor / IDE / Language Tooling ───────────────────────────────────────
  'https://github.com/nicolo-ribaudo/nvim',
  'https://github.com/neovim/neovim',
  'https://github.com/codemirror/dev',
  'https://github.com/microsoft/monaco-editor',
  'https://github.com/microsoft/language-server-protocol',
  'https://github.com/nicolo-ribaudo/tree-sitter',
  'https://github.com/tree-sitter/tree-sitter',
  'https://github.com/helix-editor/helix',
  'https://github.com/zed-industries/zed',

  // ── HTTP / API Clients ────────────────────────────────────────────────────
  'https://github.com/axios/axios',
  'https://github.com/sindresorhus/got',
  'https://github.com/sindresorhus/ky',
  'https://github.com/node-fetch/node-fetch',
  'https://github.com/psf/requests',
  'https://github.com/encode/httpx',
  'https://github.com/nicolo-ribaudo/hurl',
  'https://github.com/Orange-OpenSource/hurl',
  'https://github.com/ducaale/xh',

  // ── GraphQL ───────────────────────────────────────────────────────────────
  'https://github.com/graphql/graphql-js',
  'https://github.com/apollographql/apollo-server',
  'https://github.com/apollographql/apollo-client',
  'https://github.com/urql-graphql/urql',
  'https://github.com/graphql-yoga/graphql-yoga',
  'https://github.com/nicolo-ribaudo/pothos',
  'https://github.com/nicolo-ribaudo/gqlgen',
  'https://github.com/99designs/gqlgen',
  'https://github.com/nicolo-ribaudo/strawberry',
  'https://github.com/strawberry-graphql/strawberry',

  // ── gRPC / Protobuf / Serialization ──────────────────────────────────────
  'https://github.com/grpc/grpc-node',
  'https://github.com/grpc/grpc',
  'https://github.com/bufbuild/buf',
  'https://github.com/nicolo-ribaudo/protobuf',
  'https://github.com/protocolbuffers/protobuf',
  'https://github.com/nicolo-ribaudo/flatbuffers',
  'https://github.com/google/flatbuffers',
  'https://github.com/msgpack/msgpack-javascript',

  // ── OpenAPI / API Specs ───────────────────────────────────────────────────
  'https://github.com/swagger-api/swagger-ui',
  'https://github.com/scalar/scalar',
  'https://github.com/Kong/insomnia',
  'https://github.com/usebruno/bruno',
  'https://github.com/nicolo-ribaudo/redoc',
  'https://github.com/Redocly/redoc',

  // ── Validation & Schemas ──────────────────────────────────────────────────
  'https://github.com/colinhacks/zod',
  'https://github.com/jquense/yup',
  'https://github.com/ajv-validator/ajv',
  'https://github.com/pydantic/pydantic',
  'https://github.com/typestack/class-validator',
  'https://github.com/fabian-hiller/valibot',
  'https://github.com/nicolo-ribaudo/arktype',
  'https://github.com/arktypeio/arktype',
  'https://github.com/nicolo-ribaudo/typebox',
  'https://github.com/sinclairzx81/typebox',

  // ── State Management ──────────────────────────────────────────────────────
  'https://github.com/reduxjs/redux',
  'https://github.com/pmndrs/zustand',
  'https://github.com/mobxjs/mobx',
  'https://github.com/pmndrs/jotai',
  'https://github.com/pmndrs/valtio',
  'https://github.com/TanStack/query',
  'https://github.com/vercel/swr',
  'https://github.com/nicolo-ribaudo/nanostores',
  'https://github.com/nanostores/nanostores',
  'https://github.com/nicolo-ribaudo/xstate',
  'https://github.com/statelyai/xstate',
  'https://github.com/nicolo-ribaudo/legend-state',
  'https://github.com/LegendApp/legend-state',

  // ── WebSocket / Real-time ────────────────────────────────────────────────
  'https://github.com/socketio/socket.io',
  'https://github.com/websockets/ws',
  'https://github.com/nicolo-ribaudo/partykit',
  'https://github.com/partykit/partykit',
  'https://github.com/nicolo-ribaudo/liveblocks',
  'https://github.com/liveblocks/liveblocks',
  'https://github.com/nicolo-ribaudo/yjs',
  'https://github.com/yjs/yjs',

  // ── Message Queues / Job Queues ───────────────────────────────────────────
  'https://github.com/taskforcesh/bullmq',
  'https://github.com/OptimalBits/bull',
  'https://github.com/agenda/agenda',
  'https://github.com/celery/celery',
  'https://github.com/sidekiq/sidekiq',
  'https://github.com/nicolo-ribaudo/pg-boss',
  'https://github.com/timgit/pg-boss',
  'https://github.com/nicolo-ribaudo/inngest',
  'https://github.com/inngest/inngest',
  'https://github.com/nicolo-ribaudo/temporal',
  'https://github.com/temporalio/sdk-typescript',

  // ── Logging ───────────────────────────────────────────────────────────────
  'https://github.com/pinojs/pino',
  'https://github.com/winstonjs/winston',
  'https://github.com/trentm/node-bunyan',
  'https://github.com/encode/structlog',
  'https://github.com/uber-go/zap',
  'https://github.com/rs/zerolog',

  // ── Monitoring & Observability ────────────────────────────────────────────
  'https://github.com/open-telemetry/opentelemetry-js',
  'https://github.com/open-telemetry/opentelemetry-python',
  'https://github.com/prometheus/prometheus',
  'https://github.com/grafana/grafana',
  'https://github.com/jaegertracing/jaeger',
  'https://github.com/getsentry/sentry',
  'https://github.com/getsentry/sentry-javascript',
  'https://github.com/PostHog/posthog',
  'https://github.com/highlight/highlight',
  'https://github.com/nicolo-ribaudo/hyperdx',
  'https://github.com/hyperdxio/hyperdx',

  // ── DevOps / Infrastructure ───────────────────────────────────────────────
  'https://github.com/docker/compose',
  'https://github.com/kubernetes/kubernetes',
  'https://github.com/hashicorp/terraform',
  'https://github.com/ansible/ansible',
  'https://github.com/pulumi/pulumi',
  'https://github.com/helm/helm',
  'https://github.com/nicolo-ribaudo/k3s',
  'https://github.com/k3s-io/k3s',
  'https://github.com/nicolo-ribaudo/minikube',
  'https://github.com/kubernetes/minikube',
  'https://github.com/nicolo-ribaudo/podman',
  'https://github.com/containers/podman',
  'https://github.com/nicolo-ribaudo/lima',
  'https://github.com/lima-vm/lima',
  'https://github.com/nicolo-ribaudo/colima',
  'https://github.com/abiosoft/colima',
  'https://github.com/nektos/act',
  'https://github.com/actions/toolkit',
  'https://github.com/argoproj/argo-workflows',
  'https://github.com/fluxcd/flux2',
  'https://github.com/nicolo-ribaudo/skaffold',
  'https://github.com/GoogleContainerTools/skaffold',
  'https://github.com/nicolo-ribaudo/tilt',
  'https://github.com/tilt-dev/tilt',

  // ── Serverless ────────────────────────────────────────────────────────────
  'https://github.com/serverless/serverless',
  'https://github.com/sst/sst',
  'https://github.com/cloudflare/workers-sdk',
  'https://github.com/nicolo-ribaudo/opennext',
  'https://github.com/opennextjs/opennextjs-aws',

  // ── Networking / Proxy / Load Balancing ────────────────────────────────────
  'https://github.com/nicolo-ribaudo/caddy',
  'https://github.com/caddyserver/caddy',
  'https://github.com/traefik/traefik',
  'https://github.com/nicolo-ribaudo/nginx',
  'https://github.com/nginx/nginx',
  'https://github.com/envoyproxy/envoy',
  'https://github.com/istio/istio',
  'https://github.com/nicolo-ribaudo/linkerd2',
  'https://github.com/linkerd/linkerd2',
  'https://github.com/nicolo-ribaudo/haproxy',
  'https://github.com/haproxy/haproxy',

  // ── Performance / Benchmarking ────────────────────────────────────────────
  'https://github.com/grafana/k6',
  'https://github.com/locustio/locust',
  'https://github.com/artilleryio/artillery',
  'https://github.com/nicolo-ribaudo/wrk',
  'https://github.com/wg/wrk',
  'https://github.com/nicolo-ribaudo/autocannon',
  'https://github.com/mcollina/autocannon',

  // ── Profiling ─────────────────────────────────────────────────────────────
  'https://github.com/nicolo-ribaudo/0x',
  'https://github.com/davidmarkclements/0x',
  'https://github.com/nicolo-ribaudo/pyspy',
  'https://github.com/benfred/py-spy',
  'https://github.com/nicolo-ribaudo/clinic',
  'https://github.com/clinicjs/node-clinic',

  // ── Message Queue / Streaming ────────────────────────────────────────────
  'https://github.com/apache/kafka',
  'https://github.com/rabbitmq/rabbitmq-server',
  'https://github.com/nats-io/nats-server',
  'https://github.com/nicolo-ribaudo/nats.js',
  'https://github.com/nats-io/nats.js',
  'https://github.com/nicolo-ribaudo/emitter',
  'https://github.com/EventEmitter2/EventEmitter2',
  'https://github.com/nicolo-ribaudo/rxjs',
  'https://github.com/ReactiveX/rxjs',

  // ── Mobile ────────────────────────────────────────────────────────────────
  'https://github.com/facebook/react-native',
  'https://github.com/flutter/flutter',
  'https://github.com/expo/expo',
  'https://github.com/ionic-team/ionic-framework',
  'https://github.com/nicolo-ribaudo/nativescript',
  'https://github.com/NativeScript/NativeScript',
  'https://github.com/nicolo-ribaudo/capacitor',
  'https://github.com/ionic-team/capacitor',

  // ── Desktop ───────────────────────────────────────────────────────────────
  'https://github.com/electron/electron',
  'https://github.com/tauri-apps/tauri',
  'https://github.com/neutralinojs/neutralinojs',
  'https://github.com/nicolo-ribaudo/nwjs',
  'https://github.com/nwjs/nw.js',

  // ── Data Engineering / ML Infra ────────────────────────────────────────────
  'https://github.com/apache/airflow',
  'https://github.com/dbt-labs/dbt-core',
  'https://github.com/PrefectHQ/prefect',
  'https://github.com/dagster-io/dagster',
  'https://github.com/apache/spark',
  'https://github.com/apache/flink',
  'https://github.com/nicolo-ribaudo/ray',
  'https://github.com/ray-project/ray',
  'https://github.com/nicolo-ribaudo/dask',
  'https://github.com/dask/dask',
  'https://github.com/pandas-dev/pandas',
  'https://github.com/numpy/numpy',
  'https://github.com/nicolo-ribaudo/polars',
  'https://github.com/pola-rs/polars',
  'https://github.com/nicolo-ribaudo/pyarrow',
  'https://github.com/apache/arrow',
  'https://github.com/jupyter/notebook',
  'https://github.com/nicolo-ribaudo/marimo',
  'https://github.com/marimo-team/marimo',
  'https://github.com/nicolo-ribaudo/dlt',
  'https://github.com/dlt-hub/dlt',

  // ── Data Visualization / Charting ────────────────────────────────────────
  'https://github.com/d3/d3',
  'https://github.com/chartjs/Chart.js',
  'https://github.com/nicolo-ribaudo/echarts',
  'https://github.com/apache/echarts',
  'https://github.com/nicolo-ribaudo/recharts',
  'https://github.com/recharts/recharts',
  'https://github.com/nicolo-ribaudo/tremor',
  'https://github.com/tremorlabs/tremor',
  'https://github.com/plotly/plotly.py',
  'https://github.com/altair-viz/altair',
  'https://github.com/nicolo-ribaudo/visx',
  'https://github.com/airbnb/visx',
  'https://github.com/nicolo-ribaudo/vega',
  'https://github.com/vega/vega',
  'https://github.com/nicolo-ribaudo/vega-lite',
  'https://github.com/vega/vega-lite',
  'https://github.com/nicolo-ribaudo/observable-plot',
  'https://github.com/observablehq/plot',

  // ── Maps / Geospatial ─────────────────────────────────────────────────────
  'https://github.com/Leaflet/Leaflet',
  'https://github.com/mapbox/mapbox-gl-js',
  'https://github.com/visgl/deck.gl',
  'https://github.com/openlayers/openlayers',
  'https://github.com/nicolo-ribaudo/turf',
  'https://github.com/Turfjs/turf',

  // ── 3D / WebGL / Game ────────────────────────────────────────────────────
  'https://github.com/mrdoob/three.js',
  'https://github.com/BabylonJS/Babylon.js',
  'https://github.com/pmndrs/react-three-fiber',
  'https://github.com/pmndrs/drei',
  'https://github.com/nicolo-ribaudo/ogl',
  'https://github.com/oframe/ogl',
  'https://github.com/godotengine/godot',
  'https://github.com/photonstorm/phaser',
  'https://github.com/pixijs/pixijs',
  'https://github.com/nicolo-ribaudo/kaboom',
  'https://github.com/replit/kaboom',
  'https://github.com/nicolo-ribaudo/excalibur',
  'https://github.com/excaliburjs/Excalibur',

  // ── Image / Media Processing ────────────────────────────────────────────────
  'https://github.com/lovell/sharp',
  'https://github.com/nicolo-ribaudo/jimp',
  'https://github.com/jimp-dev/jimp',
  'https://github.com/nicolo-ribaudo/ffmpeg.wasm',
  'https://github.com/ffmpegwasm/ffmpeg.wasm',
  'https://github.com/nicolo-ribaudo/fabricjs',
  'https://github.com/fabricjs/fabric.js',
  'https://github.com/nicolo-ribaudo/konva',
  'https://github.com/konvajs/konva',

  // ── PDF / Document Generation ─────────────────────────────────────────────
  'https://github.com/diegomura/react-pdf',
  'https://github.com/nicolo-ribaudo/pdfkit',
  'https://github.com/foliojs/pdfkit',
  'https://github.com/nicolo-ribaudo/puppeteer',
  'https://github.com/nicolo-ribaudo/weasyprint',
  'https://github.com/Kozea/WeasyPrint',
  'https://github.com/nicolo-ribaudo/pagedjs',
  'https://github.com/pagedjs/pagedjs',

  // ── E-commerce ────────────────────────────────────────────────────────────
  'https://github.com/medusajs/medusa',
  'https://github.com/nicolo-ribaudo/saleor',
  'https://github.com/saleor/saleor',
  'https://github.com/nicolo-ribaudo/vendure',
  'https://github.com/vendure-ecommerce/vendure',

  // ── Email / Notifications ─────────────────────────────────────────────────
  'https://github.com/nodemailer/nodemailer',
  'https://github.com/resend/resend-node',
  'https://github.com/nicolo-ribaudo/react-email',
  'https://github.com/resend/react-email',
  'https://github.com/nicolo-ribaudo/mjml',
  'https://github.com/mjmlio/mjml',

  // ── File / Cloud Storage ──────────────────────────────────────────────────
  'https://github.com/aws/aws-sdk-js-v3',
  'https://github.com/minio/minio-js',
  'https://github.com/nicolo-ribaudo/uploadthing',
  'https://github.com/pingdotgg/uploadthing',
  'https://github.com/nicolo-ribaudo/filepond',
  'https://github.com/pqina/filepond',

  // ── Payments ──────────────────────────────────────────────────────────────
  'https://github.com/stripe/stripe-node',
  'https://github.com/nicolo-ribaudo/lemon-squeezy',
  'https://github.com/nicolo-ribaudo/polar',
  'https://github.com/polarsource/polar',

  // ── Analytics / Feature Flags ────────────────────────────────────────────
  'https://github.com/PostHog/posthog',
  'https://github.com/nicolo-ribaudo/plausible',
  'https://github.com/plausible/analytics',
  'https://github.com/nicolo-ribaudo/umami',
  'https://github.com/umami-software/umami',
  'https://github.com/nicolo-ribaudo/growthbook',
  'https://github.com/growthbook/growthbook',
  'https://github.com/nicolo-ribaudo/flagsmith',
  'https://github.com/Flagsmith/flagsmith',

  // ── i18n / Localisation ───────────────────────────────────────────────────
  'https://github.com/i18next/i18next',
  'https://github.com/nicolo-ribaudo/formatjs',
  'https://github.com/formatjs/formatjs',
  'https://github.com/nicolo-ribaudo/lingui',
  'https://github.com/lingui/js-lingui',
  'https://github.com/nicolo-ribaudo/typesafe-i18n',
  'https://github.com/ivanhofer/typesafe-i18n',

  // ── Documentation / Markdown ──────────────────────────────────────────────
  'https://github.com/remarkjs/remark',
  'https://github.com/nicolo-ribaudo/marked',
  'https://github.com/markedjs/marked',
  'https://github.com/nicolo-ribaudo/markdown-it',
  'https://github.com/markdown-it/markdown-it',
  'https://github.com/nicolo-ribaudo/shiki',
  'https://github.com/shikijs/shiki',
  'https://github.com/nicolo-ribaudo/prism',
  'https://github.com/PrismJS/prism',

  // ── Accessibility ─────────────────────────────────────────────────────────
  'https://github.com/nicolo-ribaudo/axe-core',
  'https://github.com/dequelabs/axe-core',
  'https://github.com/nicolo-ribaudo/aria-query',
  'https://github.com/A11yance/aria-query',

  // ── Browser Extensions / Web Components ───────────────────────────────────
  'https://github.com/nicolo-ribaudo/plasmo',
  'https://github.com/PlasmoHQ/plasmo',
  'https://github.com/nicolo-ribaudo/wxt',
  'https://github.com/wxt-dev/wxt',
  'https://github.com/lit/lit',
  'https://github.com/nicolo-ribaudo/shoelace',
  'https://github.com/shoelace-style/shoelace',

  // ── Blockchain / Web3 ─────────────────────────────────────────────────────
  'https://github.com/ethereum/go-ethereum',
  'https://github.com/wevm/viem',
  'https://github.com/ethers-io/ethers.js',
  'https://github.com/web3/web3.js',
  'https://github.com/foundry-rs/foundry',
  'https://github.com/nicolo-ribaudo/hardhat',
  'https://github.com/NomicFoundation/hardhat',
  'https://github.com/nicolo-ribaudo/wagmi',
  'https://github.com/wevm/wagmi',
  'https://github.com/nicolo-ribaudo/thirdweb',
  'https://github.com/thirdweb-dev/js',

  // ── IoT / Embedded / Edge ─────────────────────────────────────────────────
  'https://github.com/nicolo-ribaudo/johnny-five',
  'https://github.com/rwaldron/johnny-five',
  'https://github.com/nicolo-ribaudo/mongoose-os',
  'https://github.com/cesanta/mongoose',
  'https://github.com/nicolo-ribaudo/micropython',
  'https://github.com/micropython/micropython',
  'https://github.com/nicolo-ribaudo/zephyr',
  'https://github.com/zephyrproject-rtos/zephyr',

  // ── Scientific Computing / ML ─────────────────────────────────────────────
  'https://github.com/numpy/numpy',
  'https://github.com/scipy/scipy',
  'https://github.com/scikit-learn/scikit-learn',
  'https://github.com/matplotlib/matplotlib',
  'https://github.com/nicolo-ribaudo/seaborn',
  'https://github.com/mwaskom/seaborn',
  'https://github.com/nicolo-ribaudo/sympy',
  'https://github.com/sympy/sympy',

  // ── Distributed Systems / Service Mesh ────────────────────────────────────
  'https://github.com/nicolo-ribaudo/dapr',
  'https://github.com/dapr/dapr',
  'https://github.com/nicolo-ribaudo/consul',
  'https://github.com/hashicorp/consul',
  'https://github.com/nicolo-ribaudo/etcd',
  'https://github.com/etcd-io/etcd',

  // ── Utilities ─────────────────────────────────────────────────────────────
  'https://github.com/lodash/lodash',
  'https://github.com/nicolo-ribaudo/radash',
  'https://github.com/nicolo-ribaudo/remeda',
  'https://github.com/remeda/remeda',
  'https://github.com/date-fns/date-fns',
  'https://github.com/iamkun/dayjs',
  'https://github.com/nicolo-ribaudo/luxon',
  'https://github.com/moment/luxon',
  'https://github.com/ramda/ramda',
  'https://github.com/nicolo-ribaudo/effect',
  'https://github.com/Effect-TS/effect',

  // ── WebAssembly / Cross-platform Runtimes ──────────────────────────────────
  'https://github.com/bytecodealliance/wasmtime',
  'https://github.com/wasmerio/wasmer',
  'https://github.com/nicolo-ribaudo/wasm-pack',
  'https://github.com/rustwasm/wasm-pack',
  'https://github.com/nicolo-ribaudo/javy',
  'https://github.com/bytecodealliance/javy',
];

// Deduplicate and filter invalid entries
const UNIQUE_SEED_TOOLS = [
  ...new Set(
    SEED_TOOLS.filter(
      (url) => url.startsWith('https://github.com/') && !url.includes('nicolo-ribaudo'), // filter out placeholder entries
    ),
  ),
];

async function main() {
  let _created = 0;
  let _skipped = 0;

  for (const url of UNIQUE_SEED_TOOLS) {
    const existing = await prisma.indexedTool.findUnique({ where: { github_url: url } });
    if (existing) {
      _skipped++;
      continue;
    }
    await prisma.indexedTool.create({
      data: {
        github_url: url,
        index_status: 'pending',
      },
    });
    _created++;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

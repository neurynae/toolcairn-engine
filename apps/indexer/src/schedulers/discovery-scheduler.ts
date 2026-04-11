/**
 * Discovery Scheduler — finds new tools from GitHub and enqueues them for indexing.
 *
 * Two complementary strategies:
 *
 * 1. TOPIC-BASED DISCOVERY (runDiscoveryScheduler)
 *    Searches GitHub for repos matching a topic list. On first run uses
 *    DEFAULT_DISCOVERY_TOPICS (comprehensive, covers all dev domains). On
 *    subsequent runs uses AppSettings.discovery_topics so admins can extend it.
 *
 * 2. AUTO-TOPIC EXPANSION (expandDiscoveryTopicsFromGraph)
 *    After each discovery cycle, mines the topics already on indexed tools in
 *    Memgraph. Topics appearing frequently on quality tools that aren't in the
 *    current list are automatically added to AppSettings.discovery_topics. This
 *    makes the topic list grow organically — no manual curation needed over time.
 */

import { PrismaClient } from '@toolcairn/db';
import { getMemgraphSession } from '@toolcairn/graph';
import { enqueueIndexJob } from '@toolcairn/queue';
import { createLogger } from '@toolcairn/errors';
import { discoverReposAcrossTopics } from '../crawlers/github-discovery.js';
import { clearProgress, setProgress } from '../progress.js';

const logger = createLogger({ name: '@toolcairn/indexer:discovery-scheduler' });

export interface DiscoveryResult {
  found: number;
  newToSystem: number;
  enqueued: number;
  errors: string[];
  newTopicsAdded?: number;
}

interface DiscoverySettings {
  enabled: boolean;
  topics: string[];
  batchSize: number;
  minStars: number;
  lastPushedDays: number;
}

/**
 * Default discovery topics — verified real GitHub repository topic tags with
 * meaningful coverage (tested against stars:>100 filter on GitHub Search API).
 *
 * Organized by domain. All topics are lowercase and hyphen-separated as GitHub
 * normalises them. When AppSettings.discovery_topics is empty/null, this is used.
 *
 * To add a topic: verify it returns results with:
 *   curl "https://api.github.com/search/repositories?q=topic:<name>+stars:>100&per_page=1"
 */
export const DEFAULT_DISCOVERY_TOPICS: string[] = [
  // ── AI / LLM ──────────────────────────────────────────────────────────────
  'ai',
  'machine-learning',
  'deep-learning',
  'llm',
  'llm-framework',
  'large-language-model',
  'generative-ai',
  'rag',
  'retrieval-augmented-generation',
  'embedding',
  'embeddings',
  'vector-database',
  'vector-db',
  'vector-search',
  'transformers',
  'pytorch',
  'tensorflow',
  'nlp',
  'computer-vision',
  'langchain',
  'llamaindex',
  'huggingface',
  'fine-tuning',
  'inference',
  'model-serving',
  'reinforcement-learning',
  'stable-diffusion',
  'image-generation',
  'speech-recognition',
  'text-to-speech',

  // ── MCP / Agents ──────────────────────────────────────────────────────────
  'mcp',
  'mcp-server',
  'model-context-protocol',
  'agent',
  'ai-agent',
  'autonomous-agent',
  'multi-agent',
  'chatbot',
  'conversational-ai',

  // ── Web Frameworks (Node.js / Bun / Deno) ─────────────────────────────────
  'web-framework',
  'rest-api',
  'express',
  'fastify',
  'nestjs',
  'hono',
  'koa',
  'adonisjs',
  'nodejs',
  'deno',
  'bun',

  // ── Web Frameworks (Python) ───────────────────────────────────────────────
  'django',
  'flask',
  'fastapi',
  'rails',
  'laravel',

  // ── Web Frameworks (Go / Java / other) ───────────────────────────────────
  'spring-boot',
  'gin',
  'echo',
  'grpc',
  'openapi',

  // ── Frontend Frameworks ────────────────────────────────────────────────────
  'react',
  'vue',
  'angular',
  'svelte',
  'solid',
  'nextjs',
  'nuxt',
  'astro',
  'remix',

  // ── Styling / CSS ──────────────────────────────────────────────────────────
  'tailwindcss',
  'sass',
  'postcss',
  'css-framework',
  'styled-components',
  'design-system',
  'bootstrap',
  'component-library',
  'shadcn-ui',
  'storybook',
  'animation',
  'framer-motion',

  // ── Testing ────────────────────────────────────────────────────────────────
  'testing',
  'jest',
  'vitest',
  'playwright',
  'cypress',
  'pytest',
  'mocha',
  'unit-testing',
  'end-to-end-testing',
  'test-framework',
  'load-testing',
  'benchmarking',
  'performance',

  // ── Databases (Relational) ─────────────────────────────────────────────────
  'database',
  'orm',
  'sql',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'sqlite',
  'timeseries',
  'influxdb',
  'caching',

  // ── Databases (Search / Vector) ────────────────────────────────────────────
  'elasticsearch',
  'meilisearch',
  'typesense',
  'full-text-search',

  // ── ORMs / Query builders ──────────────────────────────────────────────────
  'prisma',
  'typeorm',
  'drizzle',
  'sequelize',

  // ── Authentication & Security ──────────────────────────────────────────────
  'authentication',
  'authorization',
  'oauth',
  'oauth2',
  'jwt',
  'openid-connect',
  'saml',
  'security',
  'cryptography',
  'ldap',
  'penetration-testing',
  'fuzzing',

  // ── Build tools & DX ──────────────────────────────────────────────────────
  'vite',
  'webpack',
  'bundler',
  'eslint',
  'linter',
  'formatter',
  'typescript',
  'compiler',
  'parser',
  'code-generator',
  'scaffolding',
  'monorepo',
  'package-manager',

  // ── CLI / Terminal ─────────────────────────────────────────────────────────
  'cli',
  'command-line',
  'terminal',
  'neovim',
  'vim',
  'tmux',
  'automation',

  // ── HTTP / API ─────────────────────────────────────────────────────────────
  'http-client',
  'graphql',
  'websocket',
  'socket-io',
  'rest-client',
  'api-gateway',
  'reverse-proxy',

  // ── State management ───────────────────────────────────────────────────────
  'state-management',
  'redux',
  'zustand',

  // ── Validation & schemas ───────────────────────────────────────────────────
  'validation',
  'schema-validation',
  'pydantic',
  'serialization',
  'protobuf',

  // ── DevOps / Infrastructure ────────────────────────────────────────────────
  'docker',
  'kubernetes',
  'terraform',
  'ansible',
  'pulumi',
  'ci-cd',
  'github-actions',
  'devops',
  'infrastructure-as-code',
  'serverless',
  'aws-lambda',
  'cloudflare-workers',
  'helm',
  'service-mesh',
  'nginx',
  'traefik',
  'cdn',
  'edge',

  // ── Monitoring / Observability ─────────────────────────────────────────────
  'monitoring',
  'observability',
  'opentelemetry',
  'logging',
  'tracing',
  'metrics',
  'prometheus',
  'grafana',
  'profiling',
  'dashboard',

  // ── Queue / Messaging / Events ─────────────────────────────────────────────
  'message-queue',
  'kafka',
  'rabbitmq',
  'celery',
  'job-queue',
  'background-jobs',
  'event-driven',
  'pub-sub',
  'mqtt',
  'amqp',
  'nats',
  'workflow',

  // ── Mobile ─────────────────────────────────────────────────────────────────
  'react-native',
  'flutter',
  'expo',
  'ionic',
  'android',
  'ios',
  'swift',
  'kotlin',

  // ── Desktop ────────────────────────────────────────────────────────────────
  'electron',
  'tauri',
  'terminal',

  // ── Data Engineering / ML Infra ────────────────────────────────────────────
  'data-pipeline',
  'etl',
  'apache-airflow',
  'airflow',
  'dbt',
  'spark',
  'flink',
  'pandas',
  'numpy',
  'data-science',
  'jupyter',
  'jupyter-notebook',
  'kaggle',
  'data-visualization',
  'analytics',

  // ── Static Site Generators / Docs ─────────────────────────────────────────
  'static-site-generator',
  'documentation',
  'docusaurus',
  'hugo',
  'jekyll',
  'gatsby',
  'eleventy',
  'hexo',
  'vitepress',

  // ── CMS ────────────────────────────────────────────────────────────────────
  'cms',
  'headless-cms',
  'wordpress',
  'ghost',

  // ── i18n / Localisation ────────────────────────────────────────────────────
  'i18n',
  'internationalization',

  // ── Maps / Geo ─────────────────────────────────────────────────────────────
  'geospatial',
  'mapbox',
  'leaflet',

  // ── Media / Rich Content ───────────────────────────────────────────────────
  'pdf',
  'image-processing',
  'video',
  'streaming',
  'ffmpeg',
  'webrtc',
  'audio',

  // ── Collaboration / CRDT ──────────────────────────────────────────────────
  'crdt',
  'real-time',

  // ── E-commerce ─────────────────────────────────────────────────────────────
  'ecommerce',
  'shopify',
  'payment',
  'stripe',

  // ── Low-code / Workflow ────────────────────────────────────────────────────
  'low-code',
  'no-code',
  'workflow',
  'automation',

  // ── Browser / Extensions ──────────────────────────────────────────────────
  'browser-extension',
  'chrome-extension',
  'vscode-extension',
  'language-server',
  'web-components',
  'accessibility',
  'a11y',

  // ── Distributed / Microservices ────────────────────────────────────────────
  'microservices',
  'distributed-systems',
  'service-mesh',
  'p2p',
  'ipfs',

  // ── Storage / Files ────────────────────────────────────────────────────────
  'file-storage',
  'object-storage',
  's3',
  'storage',

  // ── Email / Notifications ─────────────────────────────────────────────────
  'email',
  'smtp',
  'push-notification',
  'server-sent-events',

  // ── Feature flags / Experimentation ───────────────────────────────────────
  'feature-flags',

  // ── Package management ─────────────────────────────────────────────────────
  'dependency-management',
  'dependency-injection',

  // ── Blockchain / Web3 ──────────────────────────────────────────────────────
  'blockchain',
  'ethereum',
  'web3',
  'smart-contract',

  // ── Game / 3D ──────────────────────────────────────────────────────────────
  'game-engine',
  'gamedev',
  'game-development',

  // ── Systems Programming ────────────────────────────────────────────────────
  'rust',
  'go',
  'golang',
  'webassembly',
  'wasm',
  'programming-language',
  'compiler',
  'iot',
  'embedded',
  'raspberry-pi',
  'micropython',

  // ── SDK / Client libraries ─────────────────────────────────────────────────
  'sdk',
  'api-client',
  'client-library',
  'api-wrapper',
];

// ── Automatic topic expansion ────────────────────────────────────────────────

/**
 * Mine topics from tools already indexed in Memgraph and append any new
 * high-frequency topics to AppSettings.discovery_topics.
 *
 * This runs after every discovery cycle so the list self-expands as more tools
 * are indexed — no manual curation needed over time.
 *
 * @param minFrequency - Minimum times a topic must appear across indexed tools
 * @param maxNew       - Maximum new topics to add per cycle
 */
export async function expandDiscoveryTopicsFromGraph(
  prisma: PrismaClient,
  minFrequency = 5,
  maxNew = 30,
): Promise<number> {
  const session = getMemgraphSession();
  try {
    // Get the most common topics across all indexed tools
    const result = await session.run(
      `MATCH (t:Tool)
       WHERE t.topics IS NOT NULL AND size(t.topics) > 0
       UNWIND t.topics AS topic
       WITH topic, count(*) AS freq
       WHERE freq >= $minFreq AND topic <> ''
       RETURN topic, freq
       ORDER BY freq DESC
       LIMIT 200`,
      { minFreq: minFrequency },
    );

    if (result.records.length === 0) return 0;

    // Fetch current discovery topics from DB
    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const currentTopics = new Set<string>([
      ...(settings?.discovery_topics ?? []),
      ...DEFAULT_DISCOVERY_TOPICS,
    ]);

    // Collect new topics not already in the list
    const newTopics: string[] = [];
    for (const record of result.records) {
      const topic = record.get('topic') as string;
      // Skip obviously noisy / overly generic topics
      if (!topic || topic.length < 3 || topic.length > 40) continue;
      if (currentTopics.has(topic)) continue;
      newTopics.push(topic);
      if (newTopics.length >= maxNew) break;
    }

    if (newTopics.length === 0) return 0;

    // Merge into AppSettings.discovery_topics
    const existing = settings?.discovery_topics ?? [];
    const merged = [...existing, ...newTopics];
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', discovery_topics: merged },
      update: { discovery_topics: merged },
    });

    logger.info(
      { added: newTopics.length, sample: newTopics.slice(0, 5) },
      'Auto-expanded discovery topics from graph',
    );
    return newTopics.length;
  } catch (e) {
    // Non-fatal — discovery still runs with existing topics
    logger.warn({ err: e }, 'Topic auto-expansion failed — skipping');
    return 0;
  } finally {
    await session.close();
  }
}

// ── Settings loader ──────────────────────────────────────────────────────────

async function getSettings(prisma: PrismaClient): Promise<DiscoverySettings> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'global' },
  });

  return {
    enabled: settings?.discovery_scheduler_enabled ?? false,
    topics:
      settings?.discovery_topics && settings.discovery_topics.length > 0
        ? settings.discovery_topics
        : DEFAULT_DISCOVERY_TOPICS,
    batchSize: settings?.discovery_batch_size ?? 20,
    minStars: settings?.discovery_min_stars ?? 100,
    lastPushedDays: settings?.discovery_last_pushed_days ?? 90,
  };
}

async function getIndexedUrls(prisma: PrismaClient): Promise<Set<string>> {
  const tools = await prisma.indexedTool.findMany({
    select: { github_url: true },
    where: { index_status: { in: ['indexed', 'pending'] } },
  });
  return new Set(tools.map((t) => t.github_url));
}

// ── Main scheduler ───────────────────────────────────────────────────────────

/**
 * Run the discovery scheduler once.
 * Finds new repos from GitHub, enqueues them for indexing, then expands the
 * topic list automatically from newly indexed tool metadata.
 */
export async function runDiscoveryScheduler(): Promise<DiscoveryResult> {
  const prisma = new PrismaClient();

  try {
    await setProgress('Checking discovery settings…');
    const settings = await getSettings(prisma);

    if (!settings.enabled) {
      logger.info('Discovery scheduler is disabled — skipping run');
      await clearProgress();
      return { found: 0, newToSystem: 0, enqueued: 0, errors: [] };
    }

    logger.info(
      {
        topicCount: settings.topics.length,
        batchSize: settings.batchSize,
        minStars: settings.minStars,
      },
      'Starting discovery scheduler',
    );

    await setProgress('Loading already-indexed tools…');
    const indexedUrls = await getIndexedUrls(prisma);
    logger.info({ indexedCount: indexedUrls.size }, 'Fetched already-indexed tools');

    await setProgress(
      `Searching GitHub across ${settings.topics.length} topics (min ${settings.minStars}★)…`,
      `Topics: ${settings.topics.slice(0, 5).join(', ')}${settings.topics.length > 5 ? ` +${settings.topics.length - 5} more` : ''}`,
    );
    const discovered = await discoverReposAcrossTopics(
      settings.topics,
      settings.minStars,
      settings.lastPushedDays,
      settings.batchSize * 2,
    );

    logger.info({ discovered: discovered.length }, 'GitHub discovery complete');

    await setProgress(`Found ${discovered.length} repos — filtering already-indexed…`);
    const newRepos = discovered.filter((repo) => {
      const url = `https://github.com/${repo.fullName}`;
      return !indexedUrls.has(url);
    });

    const toEnqueue = newRepos.slice(0, settings.batchSize);
    await setProgress(
      `Enqueuing ${toEnqueue.length} new repos for indexing…`,
      `${newRepos.length} new found, ${discovered.length - newRepos.length} already known`,
      { found: discovered.length, newToSystem: newRepos.length, enqueuing: toEnqueue.length },
    );

    let enqueued = 0;
    const errors: string[] = [];

    for (const repo of toEnqueue) {
      try {
        const result = await enqueueIndexJob(`https://github.com/${repo.fullName}`, 0);
        if (result.ok) {
          enqueued++;
        } else {
          errors.push(`Failed to enqueue ${repo.fullName}: ${result.error}`);
        }
      } catch (err) {
        errors.push(
          `Error enqueuing ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        logger.error({ repo: repo.fullName, err }, 'Failed to enqueue');
      }
    }

    // Update last_discovery_run
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', last_discovery_run: new Date() },
      update: { last_discovery_run: new Date() },
    });

    // Auto-expand topic list from graph — non-fatal if it fails
    await setProgress('Expanding topic list from indexed tool metadata…');
    const newTopicsAdded = await expandDiscoveryTopicsFromGraph(prisma);

    await setProgress(
      `Discovery complete — ${enqueued} new repos queued`,
      errors.length > 0 ? `${errors.length} enqueue errors` : undefined,
      { found: discovered.length, newToSystem: newRepos.length, enqueued, newTopicsAdded },
    );

    logger.info(
      { found: discovered.length, newToSystem: newRepos.length, enqueued, newTopicsAdded },
      'Discovery scheduler complete',
    );

    return {
      found: discovered.length,
      newToSystem: newRepos.length,
      enqueued,
      errors,
      newTopicsAdded,
    };
  } catch (err) {
    await setProgress('Discovery failed — see indexer logs');
    logger.error({ err }, 'Discovery scheduler failed');
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

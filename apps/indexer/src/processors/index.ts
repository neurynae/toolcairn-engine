import { createHash } from 'node:crypto';
import type { DeploymentModel, ToolNode } from '@toolcairn/core';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { createLogger } from '@toolcairn/errors';
import type { CrawlerResult, ProcessedTool, TopicEdge } from '../types.js';
import { generateEmbedding } from './embedding-processor.js';
import { calculateHealth } from './health-calculator.js';
import { extractRelationships } from './relationship-extractor.js';

const logger = createLogger({ name: '@toolcairn/indexer:processor' });

const VALID_DEPLOYMENT_MODELS: ReadonlySet<DeploymentModel> = new Set<DeploymentModel>([
  'self-hosted',
  'cloud',
  'embedded',
  'serverless',
]);

function toDeploymentModel(value: string): DeploymentModel {
  if (VALID_DEPLOYMENT_MODELS.has(value as DeploymentModel)) {
    return value as DeploymentModel;
  }
  return 'self-hosted';
}

/**
 * Normalize a GitHub URL or owner/repo string to a canonical full URL.
 * Ensures the same repo always produces the same string regardless of
 * how the URL was passed (full URL, http vs https, trailing slash, short form).
 *
 * Examples:
 *   "biomejs/biome"                  → "https://github.com/biomejs/biome"
 *   "https://github.com/biomejs/biome/" → "https://github.com/biomejs/biome"
 *   "http://github.com/biomejs/biome"  → "https://github.com/biomejs/biome"
 */
function normalizeGitHubUrl(url: string): string {
  // Strip http/https prefix and trailing slashes
  const cleaned = url
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return `https://github.com/${cleaned}`;
}

/**
 * Generate a deterministic UUID v4-shaped ID from a GitHub URL.
 * Always normalizes the URL first so different representations of the
 * same repo always produce the same ID — preventing duplicates in Qdrant/Memgraph.
 */
function deterministicId(githubUrl: string): string {
  const canonical = normalizeGitHubUrl(githubUrl);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Topics that are just programming language names — not meaningful as graph nodes
export const NOISE_TOPICS = new Set([
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'golang',
  'java',
  'ruby',
  'php',
  'csharp',
  'cpp',
  'c',
  'kotlin',
  'swift',
  'scala',
  'elixir',
  'haskell',
  'nodejs',
  'node',
  'nodejs-library',
  'nodejs-module',
  'npm',
  'npm-package',
  'hacktoberfest',
  'awesome',
  'awesome-list',
  'open-source',
  'library',
  'framework',
  'tool',
  'package',
  'module',
  'cli',
  'app',
  'application',
  'web',
  'api',
]);

// Known architectural/implementation pattern topics
const KNOWN_PATTERNS = new Set([
  'event-driven',
  'microservices',
  'serverless',
  'monorepo',
  'rest-api',
  'restful',
  'graphql',
  'ssr',
  'spa',
  'pwa',
  'jamstack',
  'headless-cms',
  'cqrs',
  'event-sourcing',
  'domain-driven-design',
  'ddd',
  'clean-architecture',
  'mvc',
  'mvvm',
  'functional',
  'reactive',
  'actor-model',
  'websocket-protocol',
  'grpc',
  'openapi',
]);

export type TopicNodeType = 'UseCase' | 'Pattern' | 'Stack';

export function inferTopicNodeType(topic: string): TopicNodeType | null {
  if (NOISE_TOPICS.has(topic)) return null;
  if (topic.includes('-stack') || (topic.includes('stack') && topic.length < 15)) return 'Stack';
  if (KNOWN_PATTERNS.has(topic)) return 'Pattern';
  return 'UseCase';
}

export function buildTopicEdges(topics: string[]): TopicEdge[] {
  const edges: TopicEdge[] = [];
  for (const topic of topics) {
    const nodeType = inferTopicNodeType(topic);
    if (!nodeType) continue;
    edges.push({
      nodeType,
      nodeName: topic,
      weight: nodeType === 'Stack' ? 0.9 : nodeType === 'UseCase' ? 0.8 : 0.75,
      confidence: 0.9,
      source: 'github_signal',
      decayRate: 0.003,
    });
  }
  return edges;
}

/**
 * Orchestrates: health-calculator → relationship-extractor → embedding-processor
 * Builds a full ProcessedTool from a CrawlerResult.
 */
export async function processTool(
  crawlerResult: CrawlerResult,
  toolRepository?: { getAllToolNames(): Promise<{ ok: boolean; data?: string[] }> },
  prevHealth?: { stars: number; updatedAt: string },
): Promise<ProcessedTool> {
  const { extracted, raw } = crawlerResult;
  const now = new Date().toISOString();

  logger.info({ toolName: extracted.name }, 'Processing tool');

  const health = calculateHealth(raw, prevHealth, extracted.owner_type, extracted.is_fork);

  // Fetch existing tools from Memgraph for dynamic relationship matching
  let existingTools: Set<string> | undefined;
  try {
    const repo = toolRepository ?? new MemgraphToolRepository();
    const result = await repo.getAllToolNames();
    if (result.ok && result.data && result.data.length > 0) {
      existingTools = new Set(result.data.map((n: string) => n.toLowerCase()));
      logger.info(
        { toolName: extracted.name, count: existingTools.size },
        'Loaded existing tools for relationship matching',
      );
    }
  } catch (e) {
    logger.warn(
      { toolName: extracted.name, err: e },
      'Failed to load existing tools, using fallback mapping',
    );
  }

  const relationships = extractRelationships(extracted, raw, existingTools);

  // Topic-based classification: GitHub topics → category + graph mesh edges
  const rawData = raw as Record<string, unknown>;
  const topics = Array.isArray(rawData.topics) ? (rawData.topics as string[]) : [];
  const meaningfulTopics = topics.filter((t) => !NOISE_TOPICS.has(t));
  const category = meaningfulTopics[0] ?? topics[0] ?? 'other';
  const topicEdges = buildTopicEdges(meaningfulTopics);

  const deploymentModels: DeploymentModel[] = extracted.deployment_models.map(toDeploymentModel);

  const normalizedGithubUrl = normalizeGitHubUrl(extracted.github_url);
  const node: ToolNode = {
    id: deterministicId(extracted.github_url),
    name: extracted.name,
    display_name: extracted.display_name,
    description: extracted.description,
    category,
    github_url: normalizedGithubUrl,
    homepage_url: extracted.homepage_url,
    owner_name: extracted.owner_name,
    owner_type: extracted.owner_type,
    is_fork: extracted.is_fork ?? false,
    ecosystem_centrality: 0,
    pagerank_score: 0,
    search_weight: 1.0,
    is_canonical: false,
    license: extracted.license,
    language: extracted.language,
    languages: extracted.languages,
    deployment_models: deploymentModels,
    package_managers: extracted.package_managers,
    health,
    docs: {
      readme_url: `${normalizedGithubUrl}/blob/main/README.md`,
      docs_url: extracted.docs_url,
      changelog_url:
        extracted.changelog_url ??
        (normalizedGithubUrl.includes('github.com')
          ? `${normalizedGithubUrl}/releases`
          : undefined),
    },
    topics: meaningfulTopics,
    created_at: now,
    updated_at: now,
  };

  let vector: number[] = [];
  try {
    vector = await generateEmbedding(node);
  } catch (e) {
    logger.warn(
      { toolName: node.name, err: e },
      'Embedding generation failed — skipping vector write',
    );
  }

  return {
    node,
    vector,
    relationships,
    topicEdges,
  };
}

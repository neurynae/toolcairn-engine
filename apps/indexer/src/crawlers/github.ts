import { Octokit } from '@octokit/rest';
import { config } from '@toolcairn/config';
import pino from 'pino';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';
import {
  corePreFlight,
  getRateLimitStatus,
  sleep,
  sleepUntilCoreReset,
  updateCoreRateState,
} from './rate-limit.js';
import { extractDocsUrl } from './readme-parser.js';

const logger = pino({ name: '@toolcairn/indexer:github-crawler' });

/**
 * Fetch the README for a repo and extract the best documentation URL.
 * Returns undefined if the README can't be fetched or has no docs link.
 * Non-fatal — errors are swallowed so they don't block the main crawl.
 */
async function fetchReadmeDocsUrl(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getReadme({ owner, repo });
    if (data.encoding === 'base64' && data.content) {
      const markdown = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return extractDocsUrl(markdown);
    }
  } catch {
    // Non-fatal — README may not exist or rate limit hit
  }
  return undefined;
}

// ─── Octokit singleton ────────────────────────────────────────────────────────

let _octokit: Octokit | undefined;

function getOctokit(): Octokit {
  if (!_octokit) {
    _octokit = new Octokit({ auth: config.GITHUB_TOKEN || undefined });
  }
  return _octokit;
}

// ─── ETag cache (in-memory, keyed by endpoint URL) ───────────────────────────
// ETags allow conditional GETs: a 304 Not Modified response costs 0 rate-limit points.

const etagCache = new Map<string, { etag: string; data: unknown }>();

// ─── Retry wrapper ────────────────────────────────────────────────────────────

const MAX_RETRIES = 4;
const SECONDARY_LIMIT_WAIT_MS = 65_000; // GitHub recommends ≥60s

/**
 * Execute a GitHub API call with automatic rate-limit / secondary-limit handling.
 * Uses the shared coreRateState from rate-limit.ts (shared with github-discovery.ts).
 * - Dynamic pacing via corePreFlight(): slows down as quota decreases.
 * - On 429 / 403 primary rate limit: waits for reset window.
 * - On 403 secondary (abuse) limit: waits 65s minimum.
 * - On 5xx: exponential back-off up to MAX_RETRIES.
 */

async function githubRequest<T>(
  cacheKey: string,
  fn: (
    headers?: Record<string, string>,
  ) => Promise<{ data: unknown; headers: Record<string, string | undefined> }>,
): Promise<T> {
  // Pre-flight: apply dynamic pacing and wait if quota is critical.
  // Uses shared coreRateState from rate-limit.ts (also used by github-discovery.ts).
  await corePreFlight();

  // Inject ETag for conditional GET (304 = free, doesn't consume quota)
  const cached = etagCache.get(cacheKey);
  const conditionalHeaders: Record<string, string> = cached ? { 'if-none-match': cached.etag } : {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fn(conditionalHeaders);
      updateCoreRateState(response.headers as Record<string, string | undefined>);

      const etag = response.headers.etag;
      if (etag) etagCache.set(cacheKey, { etag, data: response.data });

      return response.data as T;
    } catch (err: unknown) {
      const e = err as {
        status?: number;
        response?: { headers?: Record<string, string> };
      };
      const status = e.status ?? 0;
      const respHeaders = e.response?.headers ?? {};

      updateCoreRateState(respHeaders as Record<string, string | undefined>);

      // 304 Not Modified — serve from ETag cache (no quota consumed)
      if (status === 304 && cached) {
        logger.debug({ cacheKey }, 'ETag hit — serving cached response (free)');
        return cached.data as T;
      }

      // Primary rate limit (403 quota-exhausted or 429)
      if ((status === 403 && respHeaders['x-ratelimit-remaining'] === '0') || status === 429) {
        const waitMs = respHeaders['retry-after']
          ? Number(respHeaders['retry-after']) * 1000 + 500
          : undefined;
        if (waitMs) {
          logger.warn(
            { waitSec: Math.round(waitMs / 1000), attempt },
            'Primary rate limit — retry-after',
          );
          await sleep(waitMs);
        } else {
          await sleepUntilCoreReset();
        }
        continue;
      }

      // Secondary (abuse) rate limit — 403 without depleted quota
      if (status === 403) {
        const waitMs = respHeaders['retry-after']
          ? Number(respHeaders['retry-after']) * 1000 + 500
          : SECONDARY_LIMIT_WAIT_MS;
        logger.warn(
          { waitSec: Math.round(waitMs / 1000), attempt },
          'Secondary rate limit — backing off',
        );
        await sleep(waitMs);
        continue;
      }

      // Transient server error — exponential back-off
      if (status >= 500 || status === 0) {
        if (attempt >= MAX_RETRIES) break;
        const backoffMs = Math.min(2 ** attempt * 1000, 30_000) + Math.random() * 500;
        logger.warn(
          { status, attempt, backoffMs: Math.round(backoffMs) },
          'Server error — backoff retry',
        );
        await sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }

  throw new IndexerError(`GitHub request failed after ${MAX_RETRIES} retries for key: ${cacheKey}`);
}

export { githubRequest, getOctokit };

// ─── Domain helpers ───────────────────────────────────────────────────────────

function detectDeploymentModels(topics: string[]): string[] {
  const models: string[] = [];
  for (const topic of topics) {
    if (topic.includes('cloud') || topic.includes('saas')) {
      if (!models.includes('cloud')) models.push('cloud');
    }
    if (
      topic.includes('self-hosted') ||
      topic.includes('selfhosted') ||
      topic.includes('on-premise')
    ) {
      if (!models.includes('self-hosted')) models.push('self-hosted');
    }
    if (topic.includes('embedded')) {
      if (!models.includes('embedded')) models.push('embedded');
    }
    if (topic.includes('serverless')) {
      if (!models.includes('serverless')) models.push('serverless');
    }
  }
  if (models.length === 0) models.push('self-hosted');
  return models;
}

function detectPackageManagers(contents: string[]): Record<string, string> {
  const managers: Record<string, string> = {};
  for (const filename of contents) {
    if (filename === 'package.json') managers.npm = 'npm';
    if (filename === 'Cargo.toml') managers.cargo = 'cargo';
    if (filename === 'pyproject.toml' || filename === 'setup.py' || filename === 'setup.cfg')
      managers.pip = 'pip';
    if (filename === 'go.mod') managers.go = 'go';
    if (filename === 'pom.xml') managers.maven = 'maven';
    if (filename === 'build.gradle' || filename === 'build.gradle.kts') managers.gradle = 'gradle';
    if (filename === 'Gemfile') managers.gem = 'gem';
    if (filename === 'composer.json') managers.composer = 'composer';
  }
  return managers;
}

// ─── Main crawler ─────────────────────────────────────────────────────────────

export async function crawlGitHubRepo(owner: string, repo: string): Promise<CrawlerResult> {
  const octokit = getOctokit();
  const repoKey = `${owner}/${repo}`;

  try {
    // Fetch repo, languages, topics sequentially — one session per rule
    const repoData = await githubRequest<
      Awaited<ReturnType<typeof octokit.rest.repos.get>>['data']
    >(
      `repo:${repoKey}`,
      (h) =>
        octokit.rest.repos.get({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    const languages = await githubRequest<Record<string, number>>(
      `languages:${repoKey}`,
      (h) =>
        octokit.rest.repos.listLanguages({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    const topicsData = await githubRequest<{ names: string[] }>(
      `topics:${repoKey}`,
      (h) =>
        octokit.rest.repos.getAllTopics({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    // Root contents for package manager detection (non-fatal if missing)
    let rootFilenames: string[] = [];
    let packageJsonDeps: string[] = [];
    try {
      const contentsData = await githubRequest<unknown>(
        `contents:${repoKey}`,
        (h) =>
          octokit.rest.repos.getContent({ owner, repo, path: '', headers: h }) as Promise<{
            data: unknown;
            headers: Record<string, string | undefined>;
          }>,
      );
      if (Array.isArray(contentsData)) {
        rootFilenames = contentsData
          .filter(
            (item): item is { name: string } =>
              typeof item === 'object' && item !== null && 'name' in item,
          )
          .map((item) => item.name);
      }

      // Fetch package.json to extract declared dependencies for relationship mining
      if (rootFilenames.includes('package.json')) {
        try {
          const pkgFile = await githubRequest<{ content?: string; encoding?: string }>(
            `package.json:${repoKey}`,
            (h) =>
              octokit.rest.repos.getContent({
                owner,
                repo,
                path: 'package.json',
                headers: h,
              }) as Promise<{ data: unknown; headers: Record<string, string | undefined> }>,
          );
          if (pkgFile.content && pkgFile.encoding === 'base64') {
            const decoded = Buffer.from(pkgFile.content.replace(/\n/g, ''), 'base64').toString(
              'utf8',
            );
            const pkg = JSON.parse(decoded) as {
              dependencies?: Record<string, string>;
              devDependencies?: Record<string, string>;
              peerDependencies?: Record<string, string>;
            };
            packageJsonDeps = [
              ...Object.keys(pkg.dependencies ?? {}),
              ...Object.keys(pkg.devDependencies ?? {}),
              ...Object.keys(pkg.peerDependencies ?? {}),
            ];
          }
        } catch {
          // Non-fatal — just skip package.json dep mining
        }
      }
    } catch {
      // Non-fatal — just skip package manager detection
    }

    const topics = topicsData.names ?? [];
    const languageNames = Object.keys(languages);
    const primaryLanguage = repoData.language ?? languageNames[0] ?? 'unknown';
    const deploymentModels = detectDeploymentModels(topics);
    const packageManagers = detectPackageManagers(rootFilenames);

    const homepage = repoData.homepage ?? undefined;

    // README-parsed docs URL is the most targeted (e.g. links to API reference pages).
    // Homepage heuristic is a fallback for when README has no explicit docs link.
    const readmeDocsUrl = await fetchReadmeDocsUrl(getOctokit(), owner, repo);
    const homepageDocsUrl = homepage && !homepage.includes('github.com') ? homepage : undefined;
    const docsUrl = readmeDocsUrl ?? homepageDocsUrl;

    const extracted: ExtractedToolData = {
      name: repoData.name,
      display_name: repoData.name,
      description: repoData.description ?? '',
      github_url: repoData.html_url,
      homepage_url: homepage,
      docs_url: docsUrl,
      changelog_url: `${repoData.html_url}/releases`,
      owner_name: repoData.owner?.login ?? undefined,
      owner_type: (repoData.owner?.type as 'User' | 'Organization') ?? undefined,
      license: repoData.license?.spdx_id ?? 'unknown',
      language: primaryLanguage,
      languages: languageNames,
      package_managers: packageManagers,
      deployment_models: deploymentModels,
    };

    const raw: Record<string, unknown> = {
      repo: repoData,
      languages,
      deps: packageJsonDeps,
      topics,
    };

    logger.info(
      { repo: repoKey, remaining: getRateLimitStatus().core.remaining },
      'Crawl complete',
    );

    return { source: 'github', url: repoData.html_url, raw, extracted };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Failed to crawl GitHub repo ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

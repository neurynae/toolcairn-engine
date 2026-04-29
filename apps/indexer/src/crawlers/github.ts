import type { Octokit } from '@octokit/rest';
import type { PackageChannel } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { REGISTRY_CONFIGS } from '@toolcairn/registry';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';
import { enrichDescription } from './description-enricher.js';
import { verifyAndFetchAllChannels } from './download-fetcher.js';
import {
  corePreFlight,
  getBestCoreSlot,
  getRateLimitStatus,
  sleep,
  sleepUntilCoreReset,
  updateSlotFromHeaders,
} from './rate-limit.js';
import { type DiscoveredPackage, discoverDistributionChannels } from './readme-install-parser.js';
import { extractDocsUrl } from './readme-parser.js';

const logger = createLogger({ name: '@toolcairn/indexer:github-crawler' });

/**
 * Fetch the README for a repo. Returns both the docs URL and raw markdown content.
 * The content is used by:
 *   1. extractDocsUrl() — for documentation link extraction
 *   2. discoverDistributionChannels() — for install command parsing + download fetching
 * Non-fatal — errors are swallowed so they don't block the main crawl.
 */
async function fetchReadme(
  owner: string,
  repo: string,
): Promise<{ docsUrl?: string; content?: string }> {
  try {
    const { data } = await getBestCoreSlot().octokit.rest.repos.getReadme({ owner, repo });
    if (data.encoding === 'base64' && data.content) {
      const markdown = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      const docsUrl = extractDocsUrl(markdown);
      return { docsUrl, content: markdown };
    }
  } catch {
    // Non-fatal — README may not exist or rate limit hit
  }
  return {};
}

// ─── Octokit accessor (delegates to token pool) ──────────────────────────────

/** Returns the Octokit instance for the token with most remaining Core quota. */
function getOctokit(): Octokit {
  return getBestCoreSlot().octokit;
}

// ─── ETag cache (in-memory, keyed by endpoint URL) ───────────────────────────
// ETags allow conditional GETs: a 304 Not Modified response costs 0 rate-limit points.
// Capped at MAX_ETAG_ENTRIES to prevent unbounded heap growth during long indexer
// runs (38k+ repos × 5 calls each = ~190k entries without a cap).
// Eviction: drop the oldest entry when the limit is hit (FIFO via Map insertion order).

const MAX_ETAG_ENTRIES = 5_000;
const etagCache = new Map<string, { etag: string; data: unknown }>();

function setEtagCache(key: string, value: { etag: string; data: unknown }): void {
  if (etagCache.size >= MAX_ETAG_ENTRIES) {
    // Map iteration order is insertion order — delete the first (oldest) key
    const firstKey = etagCache.keys().next().value;
    if (firstKey !== undefined) etagCache.delete(firstKey);
  }
  etagCache.set(key, value);
}

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
    headers: Record<string, string>,
    oc: Octokit,
  ) => Promise<{ data: unknown; headers: Record<string, string | undefined> }>,
): Promise<T> {
  await corePreFlight();

  const cached = etagCache.get(cacheKey);
  const conditionalHeaders: Record<string, string> = cached ? { 'if-none-match': cached.etag } : {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Pick the token with most remaining quota on each attempt — after a rate-limit
    // sleep the other token may now have more headroom.
    const slot = getBestCoreSlot();

    try {
      const response = await fn(conditionalHeaders, slot.octokit);
      updateSlotFromHeaders(slot, 'core', response.headers as Record<string, string | undefined>);

      const etag = response.headers.etag;
      if (etag) setEtagCache(cacheKey, { etag, data: response.data });

      return response.data as T;
    } catch (err: unknown) {
      const e = err as {
        status?: number;
        response?: { headers?: Record<string, string> };
      };
      const status = e.status ?? 0;
      const respHeaders = e.response?.headers ?? {};

      updateSlotFromHeaders(slot, 'core', respHeaders as Record<string, string | undefined>);

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

  throw new IndexerError({
    message: `GitHub request failed after ${MAX_RETRIES} retries for key: ${cacheKey}`,
  });
}

export { githubRequest, getOctokit };

// ─── GitHub repo redirect cache (handles org-rename for ownership verification) ──
//
// Registry metadata bakes the `repository` URL at publish time. When a GitHub
// org or repo gets renamed afterward (geekan/MetaGPT → foundationagents/metagpt,
// gpt-engineer-org/gpt-engineer ← antonosika/gpt-engineer), the URL on PyPI/
// npm becomes stale even though GitHub still resolves it via 301 redirects.
//
// The verifier in download-fetcher.ts asks this resolver only when its initial
// substring check fails for a github.com URL — so for the common case (no
// rename), we pay zero extra GitHub API calls. Cached results (positive AND
// negative) survive for the lifetime of the indexer run.

const repoRedirectCache = new Map<string, string>();
// Empty string in the cache = negative result (lookup attempted, failed).

/**
 * Resolve `<old-owner>/<old-repo>` to its current canonical form via the
 * GitHub repos.get endpoint. Octokit follows 301 redirects automatically and
 * the response's `full_name` reflects the post-rename identity. Returns `null`
 * on lookup failure (404, network, etc.) so the caller doesn't get stuck.
 */
async function resolveOwnerRepoRedirect(ownerRepoKey: string): Promise<string | null> {
  const key = ownerRepoKey.toLowerCase();
  const cached = repoRedirectCache.get(key);
  if (cached !== undefined) return cached === '' ? null : cached;
  const [owner, repo] = key.split('/');
  if (!owner || !repo) {
    repoRedirectCache.set(key, '');
    return null;
  }
  try {
    const { data } = await getOctokit().rest.repos.get({ owner, repo });
    const resolved = data.full_name.toLowerCase();
    repoRedirectCache.set(key, resolved);
    return resolved;
  } catch {
    repoRedirectCache.set(key, '');
    return null;
  }
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

/**
 * Generate package-name variants for the speculative registry probe.
 *
 * Canonical package names on registries often differ from the GitHub repo name
 * by a predictable transformation. Without variants the probe misses major
 * tools systematically:
 *
 *   Suffix-strip:       `next.js`     → ["next.js", "next"]      (vercel/next.js)
 *                       `three.js`    → ["three.js", "three"]    (mrdoob/three.js)
 *                       `socket.io`   → ["socket.io", "socket"]
 *                       `discord.py`  → ["discord.py", "discord"]
 *
 *   Punctuation-strip:  `axios-mock`  → ["axios-mock", "axiosmock"]
 *                       `numpy_helper`→ ["numpy_helper", "numpyhelper"]
 *
 *   Language-suffix:    `firecrawl`   → ["firecrawl", "firecrawl-py", "firecrawl-js"]
 *                       (catches firecrawl/firecrawl → firecrawl-py on PyPI)
 *
 * Order matters — the literal name is tried first to preserve prior behaviour.
 * Variants are deduped via Set so names that don't transform produce one entry.
 */
function getNameVariants(name: string): string[] {
  const variants = new Set<string>([name]);
  // Suffix strip (.js / .io / .py / etc.)
  const stripped = name.replace(/\.(js|io|ts|py|rs|go|rb|sh)$/i, '');
  if (stripped !== name) variants.add(stripped);
  // Punctuation strip
  const noHyphens = name.replace(/-/g, '');
  if (noHyphens !== name && noHyphens.length >= 2) variants.add(noHyphens);
  const noUnderscores = name.replace(/_/g, '');
  if (noUnderscores !== name && noUnderscores.length >= 2) variants.add(noUnderscores);
  // Language-suffix variants (only when the repo name doesn't already have one)
  // Catches the pattern where the publish name appends -py/-js to disambiguate
  // (firecrawl/firecrawl → firecrawl-py on PyPI, mendableai → @mendable/firecrawl-js).
  if (!/[-.](py|js|go|rs|ts|rb|sh)$/i.test(name)) {
    variants.add(`${name}-py`);
    variants.add(`${name}-js`);
  }
  return [...variants];
}

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

// ─── Size-gate config ────────────────────────────────────────────────────────

/**
 * Star ceiling above which a repo is considered "mega" and gets a reduced-work
 * crawl path. These repos (torvalds/linux, freeCodeCamp/freeCodeCamp, etc.)
 * OOM the indexer's Node heap during full processing because their contributor
 * + commit + readme payloads are 10-100x larger than a typical tool. At this
 * threshold the full-crawl path would add ~no value anyway (the tool catalogue
 * isn't about the Linux kernel), so we fail fast with a clear skip reason.
 */
const MEGA_REPO_STAR_THRESHOLD = 150_000;

export class MegaRepoSkip extends Error {
  readonly skipReason: string;
  readonly stars: number;
  constructor(repoKey: string, stars: number) {
    super(`Skipping mega-repo ${repoKey} (${stars}★) — exceeds size threshold`);
    this.name = 'MegaRepoSkip';
    this.skipReason = 'repo_too_large_for_index';
    this.stars = stars;
  }
}

// ─── Main crawler ─────────────────────────────────────────────────────────────

export async function crawlGitHubRepo(owner: string, repo: string): Promise<CrawlerResult> {
  const repoKey = `${owner}/${repo}`;

  // Helper type alias — resolve Octokit's repos.get return type using current best token
  type RepoData = Awaited<
    ReturnType<ReturnType<typeof getBestCoreSlot>['octokit']['rest']['repos']['get']>
  >['data'];

  try {
    // Fetch repo, languages, topics — githubRequest picks the best token per call
    const repoData = await githubRequest<RepoData>(
      `repo:${repoKey}`,
      (h, oc) =>
        oc.rest.repos.get({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    // ── Mega-repo size gate ─────────────────────────────────────────────────
    // Abort before loading contributors/commits/readme for repos that would
    // OOM the Node heap during processing. Thrown here so the consumer can
    // mark the tool 'skipped' with a clear reason instead of retrying forever.
    const starCount = repoData.stargazers_count ?? 0;
    if (starCount >= MEGA_REPO_STAR_THRESHOLD) {
      logger.warn(
        { repo: repoKey, stars: starCount, threshold: MEGA_REPO_STAR_THRESHOLD },
        'Mega-repo detected — skipping to avoid OOM',
      );
      throw new MegaRepoSkip(repoKey, starCount);
    }

    const languages = await githubRequest<Record<string, number>>(
      `languages:${repoKey}`,
      (h, oc) =>
        oc.rest.repos.listLanguages({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    const topicsData = await githubRequest<{ names: string[] }>(
      `topics:${repoKey}`,
      (h, oc) =>
        oc.rest.repos.getAllTopics({ owner, repo, headers: h }) as Promise<{
          data: unknown;
          headers: Record<string, string | undefined>;
        }>,
    );

    // Root contents for package manager detection (non-fatal if missing)
    let rootFilenames: string[] = [];
    let packageJsonDeps: string[] = [];
    let npmPackageName: string | undefined;
    try {
      const contentsData = await githubRequest<unknown>(
        `contents:${repoKey}`,
        (h, oc) =>
          oc.rest.repos.getContent({ owner, repo, path: '', headers: h }) as Promise<{
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
            (h, oc) =>
              oc.rest.repos.getContent({
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
              name?: string;
              dependencies?: Record<string, string>;
              devDependencies?: Record<string, string>;
              peerDependencies?: Record<string, string>;
            };
            packageJsonDeps = [
              ...Object.keys(pkg.dependencies ?? {}),
              ...Object.keys(pkg.devDependencies ?? {}),
              ...Object.keys(pkg.peerDependencies ?? {}),
            ];
            // Capture actual npm package name (e.g. "prisma", "react") for Stage 0 exact match
            if (pkg.name) npmPackageName = pkg.name;
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
    // File-based detection (used as fallback when README has no install commands)
    const fileBasedManagers = detectPackageManagers(rootFilenames);
    // Override generic "npm" with actual package name from package.json
    if (npmPackageName && fileBasedManagers.npm) {
      fileBasedManagers.npm = npmPackageName;
    }

    const homepage = repoData.homepage ?? undefined;

    // README: fetch once, use for both docs URL extraction and install command parsing
    const readme = await fetchReadme(owner, repo);
    const homepageDocsUrl = homepage && !homepage.includes('github.com') ? homepage : undefined;
    const docsUrl = readme.docsUrl ?? homepageDocsUrl;

    // ── Download discovery (README + topics → registry probe → fetch counts) ──
    // Uses README install commands (Signal 1) and GitHub topics (Signal 2)
    // to discover distribution channels, verify ownership, and fetch download counts.
    // All external HTTP calls — no GitHub API quota impact.
    let packageChannels: PackageChannel[] = [];
    try {
      const ownerLogin = repoData.owner?.login ?? owner;
      const channels = discoverDistributionChannels(
        readme.content,
        repoData.name,
        ownerLogin,
        topics,
      );
      // Signal 3 (fallback): when README + topics yielded nothing, fan out
      // candidates across registries that ToolCairn can VERIFY ownership for
      // (i.e. have both metadataUrl + repoUrlField). Unverifiable registries
      // are excluded — they would otherwise pass through with weeklyDownloads:0
      // and pad the channel count without contributing real signal.
      //
      // Each registry probe tries multiple name variants because canonical
      // package names often differ from the GitHub repo name:
      //   `next.js`    → tries `next.js` AND `next`        (vercel/next.js)
      //   `three.js`   → tries `three.js` AND `three`      (mrdoob/three.js)
      //   `socket.io`  → tries `socket.io` AND `socket`
      //   `axios-mock` → tries `axios-mock` AND `axiosmock`
      // First verified match wins per registry (verifyAndFetchAllChannels
      // dedups by registry implicitly via the survivor set).
      const speculative: DiscoveredPackage[] =
        channels.length === 0
          ? Object.entries(REGISTRY_CONFIGS)
              .filter(([_, cfg]) => cfg.metadataUrl && cfg.repoUrlField)
              .flatMap(([registry]) =>
                getNameVariants(repoData.name).map((packageName) => ({
                  registry,
                  packageName,
                  rawCommand: 'speculative:name-match',
                  source: 'speculative' as const,
                })),
              )
          : [];
      const allCandidates = channels.length > 0 ? channels : speculative;
      if (allCandidates.length > 0) {
        // Throughput optimisation: for high-star repos (stars >= 1000) the gate
        // passes on stars alone, so we don't need download counts inline. Defer
        // the slow per-host download fetch to the registry-probe side queue.
        // Sub-1k repos still need download data inline because the gate uses
        // it to decide whether the tool is registry-popular enough to keep.
        const skipDownloads = (repoData.stargazers_count ?? 0) >= 1000;
        const verified = await verifyAndFetchAllChannels(allCandidates, ownerLogin, repoData.name, {
          resolveRedirect: resolveOwnerRepoRedirect,
          skipDownloads,
        });
        packageChannels = verified.map((ch) => ({
          registry: ch.registry,
          packageName: ch.packageName,
          installCommand: ch.installCommand,
          weeklyDownloads: ch.weeklyDownloads,
        }));
        if (speculative.length > 0 && packageChannels.length > 0) {
          logger.info(
            {
              repo: repoKey,
              channels: packageChannels.map((c) => `${c.registry}:${c.packageName}`),
            },
            'Speculative registry probe found verified channel(s) — README + topics had none',
          );
        }
      }
    } catch (e) {
      // Non-fatal — verification / download fetching should never block the main crawl.
      logger.debug({ repo: repoKey, err: e }, 'Channel verification failed (non-fatal)');
    }

    const extracted: ExtractedToolData = {
      name: repoData.name,
      display_name: repoData.name,
      description: enrichDescription(repoData.description ?? '', topics),
      github_url: repoData.html_url,
      homepage_url: homepage,
      docs_url: docsUrl,
      changelog_url: `${repoData.html_url}/releases`,
      is_fork: repoData.fork === true,
      owner_name: repoData.owner?.login ?? undefined,
      owner_type: (repoData.owner?.type as 'User' | 'Organization') ?? undefined,
      license: repoData.license?.spdx_id ?? 'unknown',
      language: primaryLanguage,
      languages: languageNames,
      package_managers: packageChannels,
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
    throw new IndexerError({
      message: `Failed to crawl GitHub repo ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

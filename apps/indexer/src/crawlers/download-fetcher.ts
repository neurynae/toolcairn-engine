/**
 * Fetch download counts from package registry APIs and verify ownership.
 *
 * Design:
 * 1. For each discovered {registry, packageName}, verify the package's
 *    repository URL points back to this GitHub repo (prevents false positives)
 * 2. Fetch download count from registry API
 * 3. Convert to weekly equivalent for cross-registry normalization
 * 4. Return the highest weekly equivalent across all channels
 *
 * All calls are non-fatal — errors return 0 downloads without blocking the crawl.
 */

import { createLogger } from '@toolcairn/errors';
import type { DiscoveredPackage } from './readme-install-parser.js';
import { REGISTRY_CONFIGS, type TimeWindow } from './registry-config.js';

const logger = createLogger({ name: '@toolcairn/indexer:download-fetcher' });

const FETCH_TIMEOUT = 5000;
const MAX_TRANSIENT_RETRIES = 1;

// ─── Per-host adaptive rate limiter ─────────────────────────────────────────
//
// We learn each registry's tolerance from its own responses — never hardcode
// a wait time or rate. Three signals from the server drive the bucket:
//
//   1. `Retry-After` header on 429 → block for exactly that long. The server
//      told us when it's safe; we honor it verbatim.
//   2. `X-RateLimit-Remaining` / `X-RateLimit-Reset` on any 2xx → if the
//      registry publishes them, compute the safe rate as
//      `remaining / (reset_epoch - now)` and cap our refill there.
//   3. 429 without Retry-After → the server didn't tell us how long. We halve
//      the current effective rate (AIMD-style multiplicative-decrease) and
//      stop sending until the next successful response. No magic numbers.
//
// On a streak of successes, the rate slowly recovers (additive-increase) so
// we don't get permanently stuck in slow mode after a transient burst.
//
// Initial state: no limit at all (we don't pretend to know the registry's
// ceiling). The first 429 — if one ever happens — teaches the bucket.

interface Bucket {
  /** Currently-available tokens. Starts ~unlimited. */
  tokens: number;
  /** Adaptive refill rate per second. Starts very high; learns down on 429s. */
  refillPerSec: number;
  /** Soft cap on refill rate (prevents accidental DoS on very forgiving hosts). */
  capacity: number;
  /** Last time the bucket was refilled (token math reference). */
  lastRefillMs: number;
  /** Hard block until this epoch ms — set by 429 + Retry-After. */
  blockedUntilMs: number;
  /** Successful fetches since last 429 — drives slow recovery of refillPerSec. */
  successesSinceBackoff: number;
}

const INITIAL_REFILL_PER_SEC = 50; // permissive — let the registry tell us if too much
const MIN_REFILL_PER_SEC = 0.5; // floor — never crawl slower than 1 req per 2s
const MAX_CAPACITY = 100;
const SUCCESSES_PER_RECOVERY = 50; // after 50 successes, increase rate 10%
const RECOVERY_FACTOR = 1.1;
const BACKOFF_DIVISOR = 2; // halve rate on a 429 with no Retry-After

const buckets = new Map<string, Bucket>();

function getBucket(host: string): Bucket {
  let b = buckets.get(host);
  if (!b) {
    b = {
      tokens: INITIAL_REFILL_PER_SEC,
      refillPerSec: INITIAL_REFILL_PER_SEC,
      capacity: MAX_CAPACITY,
      lastRefillMs: Date.now(),
      blockedUntilMs: 0,
      successesSinceBackoff: 0,
    };
    buckets.set(host, b);
  }
  return b;
}

/** Block until 1 token is available for this host. */
async function acquireToken(host: string): Promise<void> {
  const b = getBucket(host);
  while (true) {
    const now = Date.now();
    if (now < b.blockedUntilMs) {
      await new Promise((r) => setTimeout(r, b.blockedUntilMs - now));
      continue;
    }
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - b.tokens) / b.refillPerSec) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Update bucket state from a successful response. If the registry publishes
 * standard rate-limit headers, learn the true rate from them; otherwise
 * gradually recover refill speed after a streak of clean responses.
 */
function recordSuccess(host: string, resp: Response): void {
  const b = getBucket(host);
  const remaining = Number(resp.headers.get('x-ratelimit-remaining'));
  const resetRaw = resp.headers.get('x-ratelimit-reset');
  if (Number.isFinite(remaining) && resetRaw) {
    // X-RateLimit-Reset can be either epoch seconds (GitHub style) or
    // seconds-from-now (older style). Detect via magnitude.
    const resetNum = Number(resetRaw);
    const nowSec = Date.now() / 1000;
    const secondsLeft =
      resetNum > nowSec * 2 ? Math.max(1, resetNum - nowSec) : Math.max(1, resetNum);
    if (remaining > 0 && secondsLeft > 0) {
      const safeRate = Math.max(MIN_REFILL_PER_SEC, remaining / secondsLeft);
      // Only ratchet down here — never increase past observed safe rate.
      if (safeRate < b.refillPerSec) b.refillPerSec = safeRate;
    }
  } else {
    b.successesSinceBackoff++;
    if (b.successesSinceBackoff >= SUCCESSES_PER_RECOVERY) {
      b.refillPerSec = Math.min(INITIAL_REFILL_PER_SEC, b.refillPerSec * RECOVERY_FACTOR);
      b.successesSinceBackoff = 0;
    }
  }
}

/** Record a 429 — block the host as the server requested, or back off adaptively. */
function recordRateLimited(host: string, resp: Response): void {
  const b = getBucket(host);
  const retryAfterRaw = resp.headers.get('retry-after');
  const retryAfter = Number(retryAfterRaw);

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    // Server told us exactly when to retry — honor it verbatim.
    b.blockedUntilMs = Math.max(b.blockedUntilMs, Date.now() + retryAfter * 1000);
    logger.warn(
      { host, retryAfter },
      'Registry 429 with Retry-After — blocking until server-specified time',
    );
  } else {
    // No Retry-After. Back off the rate, don't invent a wait time.
    b.refillPerSec = Math.max(MIN_REFILL_PER_SEC, b.refillPerSec / BACKOFF_DIVISOR);
    logger.warn(
      { host, newRefillPerSec: b.refillPerSec },
      'Registry 429 without Retry-After — halving adaptive rate',
    );
  }
  b.tokens = 0;
  b.successesSinceBackoff = 0;
}

/**
 * Fetch JSON with adaptive per-host rate limiting. The bucket learns from
 * the server's own signals — Retry-After, X-RateLimit-* — and falls back to
 * AIMD on 429s with no guidance. Bounded retry covers genuine 5xx/network
 * failures only; 429s are handled via the bucket's block window so we don't
 * retry tightly against a wall.
 */
async function fetchJsonPaced(
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
): Promise<Response | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    await acquireToken(host);
    try {
      const resp = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (resp.ok) {
        recordSuccess(host, resp);
        return resp;
      }
      if (resp.status === 429) {
        recordRateLimited(host, resp);
        if (attempt < MAX_TRANSIENT_RETRIES) continue;
        return resp;
      }
      // Definitive 4xx (404, 403, etc.) — package doesn't exist; no retry.
      if (resp.status >= 400 && resp.status < 500) return resp;
      // 5xx — retry once after a brief pause.
      if (attempt < MAX_TRANSIENT_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_TRANSIENT_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  logger.debug({ url, err: lastErr }, 'fetchJsonPaced exhausted');
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DownloadResult {
  registry: string;
  packageName: string;
  rawDownloads: number;
  timeWindow: TimeWindow;
  weeklyEquivalent: number;
  createdAt?: string;
}

// ─── JSON field extraction ──────────────────────────────────────────────────

/**
 * Extract a value from a nested JSON object using a dot-separated path.
 * Supports array indices: "data.0.totalDownloads"
 */
function getNestedField(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ─── Weekly equivalent conversion ───────────────────────────────────────────

/**
 * Convert download count to weekly equivalent based on time window.
 */
export function convertToWeeklyEquivalent(
  downloads: number,
  timeWindow: TimeWindow,
  createdAt?: string,
): number {
  if (downloads <= 0) return 0;

  switch (timeWindow) {
    case 'weekly':
      return downloads;
    case 'monthly':
      return Math.round(downloads / 4.3);
    case '90d':
      return Math.round(downloads / 13);
    case 'alltime': {
      if (createdAt) {
        const created = new Date(createdAt);
        const weeksSinceCreation = Math.max(
          1,
          (Date.now() - created.getTime()) / (7 * 24 * 60 * 60 * 1000),
        );
        return Math.round(downloads / weeksSinceCreation);
      }
      // No creation date — assume 5 years (conservative)
      return Math.round(downloads / 260);
    }
  }
}

// ─── Ownership verification ─────────────────────────────────────────────────

/**
 * Per-registry verification outcome.
 * - `verified` — registry API returned a repo URL that matches `<owner>/<repo>`.
 * - `unverifiable` — registry has no metadataUrl/repoUrlField in config; we can't
 *   cross-check by design.
 * - `metadata_empty` — registry was reachable, but the repoUrlField is null/empty.
 *   Common for PyPI publishers who don't fill `project_urls` (open-webui, openbb)
 *   and npm publishers who omit the `repository` key (flowise, twentyhq, next.js).
 *   Caller decides based on signal source: trust if README/topic confirmed,
 *   reject if speculative-only.
 * - `rejected` — registry returned a repo URL but it doesn't match `<owner>/<repo>`.
 *   Definitive negative: the registry says this package belongs to someone else.
 */
export type OwnershipVerdict = 'verified' | 'unverifiable' | 'metadata_empty' | 'rejected';

/** Optional callback for resolving GitHub repo redirects (handles org renames). */
export type RedirectResolver = (ownerRepoKey: string) => Promise<string | null>;

/**
 * Cross-check whether a `(registry, packageName)` channel belongs to the given
 * `<owner>/<repo>` by hitting the registry's own metadata API and comparing
 * repoUrlField back against the tool's GitHub identity.
 *
 * Returns a 4-way verdict so callers can apply source-aware policy. When a
 * `resolveRedirect` callback is provided and the initial substring check fails
 * for a github.com URL, attempts one redirect resolution to handle org renames
 * (geekan/MetaGPT → foundationagents/metagpt, etc.).
 */
export async function verifyChannelOwnership(
  registry: string,
  packageName: string,
  ownerName: string,
  repoName: string,
  options?: { resolveRedirect?: RedirectResolver },
): Promise<OwnershipVerdict> {
  const config = REGISTRY_CONFIGS[registry];
  if (!config?.metadataUrl || !config.repoUrlField) {
    return 'unverifiable';
  }

  const url = config.metadataUrl.replace('{pkg}', encodeURIComponent(packageName));
  const resp = await fetchJsonPaced(url, config.headers ?? {});
  if (!resp || !resp.ok) return 'rejected';

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return 'rejected';
  }

  const repoUrlValue = getNestedField(data, config.repoUrlField);

  // The repo URL field might be a string or an object (PyPI's project_urls is a dict;
  // hex has meta.links; packagist has package.repository as a string).
  const urlsToCheck: string[] = [];
  if (typeof repoUrlValue === 'string') {
    urlsToCheck.push(repoUrlValue);
  } else if (typeof repoUrlValue === 'object' && repoUrlValue !== null) {
    urlsToCheck.push(...Object.values(repoUrlValue as Record<string, string>));
  }

  // PyPI fallback: when project_urls is null/empty, also try info.home_page
  // (some publishers fill home_page but not project_urls — e.g. metagpt).
  if (registry === 'pypi' && urlsToCheck.length === 0) {
    const homePage = getNestedField(data, 'info.home_page');
    if (typeof homePage === 'string' && homePage) urlsToCheck.push(homePage);
  }

  if (urlsToCheck.length === 0) return 'metadata_empty';

  const ownerRepo = `${ownerName}/${repoName}`.toLowerCase();
  const stringUrls = urlsToCheck.filter((u): u is string => typeof u === 'string');
  if (stringUrls.some((u) => u.toLowerCase().includes(ownerRepo))) return 'verified';

  // Initial substring check failed. If a resolver is provided AND any URL
  // points to a github.com/<other-owner>/<other-repo>, try resolving it to
  // see whether GitHub redirects that path to our expected owner/repo.
  if (options?.resolveRedirect) {
    for (const u of stringUrls) {
      const m = u.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git|\/?$|\/[#?].*)/i);
      if (!m?.[1] || !m?.[2]) continue;
      const candidateKey = `${m[1]}/${m[2]}`.toLowerCase();
      if (candidateKey === ownerRepo) continue;
      const resolved = await options.resolveRedirect(candidateKey);
      if (resolved && resolved.toLowerCase() === ownerRepo) return 'verified';
    }
  }

  return 'rejected';
}

/**
 * Internal boolean wrapper used by fetchAllDownloadCounts — keeps the pre-existing
 * "trust unverifiable" behaviour for its download-count path.
 */
async function shouldTrustChannel(
  registry: string,
  packageName: string,
  ownerName: string,
  repoName: string,
): Promise<boolean> {
  const verdict = await verifyChannelOwnership(registry, packageName, ownerName, repoName);
  return verdict !== 'rejected';
}

// ─── Download count fetching ────────────────────────────────────────────────

/**
 * Fetch download count for a single registry+package.
 * Returns null if the registry has no API or the fetch fails.
 */
async function fetchRegistryDownloads(
  registry: string,
  packageName: string,
): Promise<{ downloads: number; timeWindow: TimeWindow; createdAt?: string } | null> {
  const config = REGISTRY_CONFIGS[registry];
  if (!config?.hasDownloadApi || !config.downloadApiUrl) return null;

  try {
    // VS Code Marketplace uses POST — handle separately
    if (registry === 'vscode') {
      return await fetchVsCodeDownloads(packageName);
    }

    // Homebrew returns nested object for analytics.install.30d
    if (registry === 'homebrew') {
      return await fetchHomebrewDownloads(packageName);
    }

    const url = config.downloadApiUrl.replace('{pkg}', encodeURIComponent(packageName));
    const resp = await fetchJsonPaced(url, config.headers ?? {});
    if (!resp || !resp.ok) return null;

    const data = await resp.json();
    const rawDownloads = getNestedField(data, config.downloadField);
    const downloads = typeof rawDownloads === 'number' ? rawDownloads : 0;

    if (downloads <= 0) return null;

    // Try to extract creation date for alltime→weekly conversion
    let createdAt: string | undefined;
    if (config.timeWindow === 'alltime') {
      const created =
        getNestedField(data, 'created_at') ??
        getNestedField(data, 'created') ??
        getNestedField(data, 'info.created');
      if (typeof created === 'string') createdAt = created;
    }

    return { downloads, timeWindow: config.timeWindow, createdAt };
  } catch (e) {
    logger.debug({ registry, packageName, err: e }, 'Download fetch failed');
    return null;
  }
}

/** VS Code Marketplace uses POST with special flags. */
async function fetchVsCodeDownloads(
  extensionId: string,
): Promise<{ downloads: number; timeWindow: TimeWindow } | null> {
  try {
    const resp = await fetchJsonPaced(
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
      {
        Accept: 'application/json;api-version=3.0-preview.1',
        'Content-Type': 'application/json',
      },
      {
        method: 'POST',
        body: JSON.stringify({
          filters: [
            {
              criteria: [
                { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
                { filterType: 7, value: extensionId },
              ],
              pageSize: 1,
              pageNumber: 1,
            },
          ],
          flags: 256, // IncludeStatistics
        }),
      },
    );
    if (!resp || !resp.ok) return null;

    const data = (await resp.json()) as {
      results?: Array<{
        extensions?: Array<{
          statistics?: Array<{ statisticName: string; value: number }>;
        }>;
      }>;
    };

    const stats = data.results?.[0]?.extensions?.[0]?.statistics;
    const installStat = stats?.find((s) => s.statisticName === 'install');
    if (!installStat) return null;

    return { downloads: installStat.value, timeWindow: 'alltime' };
  } catch {
    return null;
  }
}

/** Homebrew analytics.install.30d is a nested object { "formula_name": count }. */
async function fetchHomebrewDownloads(
  formulaName: string,
): Promise<{ downloads: number; timeWindow: TimeWindow } | null> {
  try {
    const resp = await fetchJsonPaced(
      `https://formulae.brew.sh/api/formula/${encodeURIComponent(formulaName)}.json`,
      {},
    );
    if (!resp || !resp.ok) return null;

    const data = (await resp.json()) as {
      analytics?: {
        install?: {
          '30d'?: Record<string, number>;
        };
      };
    };

    const installs30d = data.analytics?.install?.['30d'];
    if (!installs30d) return null;

    // Sum all install variants (e.g. "wget": 27522, "wget --HEAD": 74)
    const total = Object.values(installs30d).reduce(
      (sum, n) => sum + (typeof n === 'number' ? n : 0),
      0,
    );
    return total > 0 ? { downloads: total, timeWindow: 'monthly' } : null;
  } catch {
    return null;
  }
}

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Fetch download counts for ALL discovered distribution channels that pass ownership verification.
 * Returns every verified result — callers decide how to aggregate.
 *
 * @param channels - Discovered packages from README parser
 * @param ownerName - GitHub repo owner
 * @param repoName - GitHub repo name
 * @returns All verified download results (may be empty)
 */
/**
 * Channel that survived ownership verification, optionally enriched with download
 * info when the registry has a download API.
 *
 * Used by the GitHub crawler to build the final `package_managers` array —
 * every entry has been cross-verified against the registry API itself (or
 * passed through as unverifiable for the subset of registries that don't
 * expose a metadata endpoint with a repo-URL field).
 */
export interface VerifiedChannel {
  registry: string;
  packageName: string;
  installCommand: string;
  /** 0 when the registry lacks a download API or the fetch failed. */
  weeklyDownloads: number;
  verdict: OwnershipVerdict;
}

/**
 * Verify every discovered channel against its registry's metadata API and
 * enrich the survivors with download counts where available. Drop policy is
 * source-aware:
 *
 *   verdict = 'verified'        → keep (registry confirmed the repo URL match)
 *   verdict = 'unverifiable'    → keep (registry has no metadata API by config)
 *   verdict = 'metadata_empty'  → keep IFF source is 'readme' or 'topic'.
 *                                 Drop for 'speculative' — without README signal
 *                                 there's nothing to validate the name match.
 *   verdict = 'rejected'        → drop (registry says repo URL is someone else's)
 *
 * The optional `resolveRedirect` callback handles GitHub org renames: when
 * verifyChannelOwnership's substring check fails for a github.com URL, it
 * calls the resolver to see whether GitHub redirects the URL's owner/repo to
 * the expected one. github.ts provides a cached implementation.
 *
 * Return order preserves input order. Rejected channels are filtered out.
 */
export async function verifyAndFetchAllChannels(
  channels: DiscoveredPackage[],
  ownerName: string,
  repoName: string,
  options?: {
    resolveRedirect?: RedirectResolver;
    /**
     * When true, only run the (cheap, fast) ownership verification step. Skip
     * the (slow, rate-limited) download-count fetch — leave weeklyDownloads=0
     * and let the side queue's registry-probe handler fill it in later.
     *
     * Used by the main indexer path to keep GitHub-bound throughput high:
     * pypistats.org and similar slow hosts don't bottleneck the main flow.
     */
    skipDownloads?: boolean;
  },
): Promise<VerifiedChannel[]> {
  if (channels.length === 0) return [];

  // Verify + (optionally) fetch downloads in parallel per channel.
  const results = await Promise.all(
    channels.map(async (ch): Promise<VerifiedChannel | null> => {
      const verdict = await verifyChannelOwnership(
        ch.registry,
        ch.packageName,
        ownerName,
        repoName,
        { resolveRedirect: options?.resolveRedirect },
      );

      // Source-aware policy.
      const drop =
        verdict === 'rejected' || (verdict === 'metadata_empty' && ch.source === 'speculative');

      if (drop) {
        logger.debug(
          {
            registry: ch.registry,
            pkg: ch.packageName,
            owner: ownerName,
            repo: repoName,
            verdict,
            source: ch.source,
          },
          'Channel dropped from package_managers',
        );
        return null;
      }

      let weekly = 0;
      if (!options?.skipDownloads) {
        const cfg = REGISTRY_CONFIGS[ch.registry];
        if (cfg?.hasDownloadApi) {
          const dl = await fetchRegistryDownloads(ch.registry, ch.packageName);
          if (dl) {
            weekly = convertToWeeklyEquivalent(dl.downloads, dl.timeWindow, dl.createdAt);
          }
        }
      }

      return {
        registry: ch.registry,
        packageName: ch.packageName,
        installCommand: ch.rawCommand,
        weeklyDownloads: weekly,
        verdict,
      };
    }),
  );

  const survivors = results.filter((r): r is VerifiedChannel => r !== null);

  if (channels.length !== survivors.length) {
    logger.info(
      {
        repo: `${ownerName}/${repoName}`,
        discovered: channels.length,
        kept: survivors.length,
        dropped: channels.length - survivors.length,
      },
      'Channel verification complete',
    );
  }

  return survivors;
}

export async function fetchAllDownloadCounts(
  channels: DiscoveredPackage[],
  ownerName: string,
  repoName: string,
): Promise<DownloadResult[]> {
  if (channels.length === 0) return [];

  // Only fetch from registries that have download APIs
  const fetchable = channels.filter((ch) => {
    const config = REGISTRY_CONFIGS[ch.registry];
    return config?.hasDownloadApi === true;
  });

  if (fetchable.length === 0) return [];

  // Fetch all in parallel (different registries, different rate limits)
  const results = await Promise.all(
    fetchable.map(async (ch): Promise<DownloadResult | null> => {
      // Verify ownership first (for registries with metadata API).
      // Keeps prior behaviour: unverifiable registries pass through (trusted).
      const trusted = await shouldTrustChannel(ch.registry, ch.packageName, ownerName, repoName);
      if (!trusted) {
        logger.debug(
          { registry: ch.registry, pkg: ch.packageName, owner: ownerName, repo: repoName },
          'Ownership verification failed — skipping',
        );
        return null;
      }

      // Fetch download count
      const dl = await fetchRegistryDownloads(ch.registry, ch.packageName);
      if (!dl) return null;

      const weeklyEquivalent = convertToWeeklyEquivalent(dl.downloads, dl.timeWindow, dl.createdAt);

      return {
        registry: ch.registry,
        packageName: ch.packageName,
        rawDownloads: dl.downloads,
        timeWindow: dl.timeWindow,
        weeklyEquivalent,
        createdAt: dl.createdAt,
      };
    }),
  );

  const verified = results.filter((r): r is DownloadResult => r !== null);

  if (verified.length > 0) {
    const best = verified.reduce((a, b) => (a.weeklyEquivalent >= b.weeklyEquivalent ? a : b));
    logger.info(
      {
        repo: `${ownerName}/${repoName}`,
        channels: verified.length,
        bestRegistry: best.registry,
        bestWeekly: best.weeklyEquivalent,
      },
      'Download counts fetched',
    );
  }

  return verified;
}

/**
 * Fetch download counts for all discovered channels and return the best result.
 * Convenience wrapper around fetchAllDownloadCounts for callers that only need
 * the single highest weekly-equivalent count.
 *
 * @param channels - Discovered packages from README parser
 * @param ownerName - GitHub repo owner
 * @param repoName - GitHub repo name
 * @returns Best download result, or null if no downloads found
 */
export async function fetchBestDownloadCount(
  channels: DiscoveredPackage[],
  ownerName: string,
  repoName: string,
): Promise<DownloadResult | null> {
  const all = await fetchAllDownloadCounts(channels, ownerName, repoName);
  if (all.length === 0) return null;
  return all.reduce((best, r) => (r.weeklyEquivalent > best.weeklyEquivalent ? r : best));
}

/**
 * Fetch weekly download count for a known registry + package name.
 * Used by dedicated crawlers (npm, pypi, crates-io) that already know
 * the registry and package name — no README parsing needed.
 *
 * Uses REGISTRY_CONFIGS as single source of truth for API URLs and fields.
 * Returns 0 if the registry has no API or the fetch fails.
 */
export async function fetchPackageDownloads(
  registry: string,
  packageName: string,
): Promise<number> {
  const dl = await fetchRegistryDownloads(registry, packageName);
  if (!dl) return 0;
  const weekly = convertToWeeklyEquivalent(dl.downloads, dl.timeWindow, dl.createdAt);
  if (weekly > 0) {
    logger.debug(
      { registry, pkg: packageName, weekly, raw: dl.downloads, window: dl.timeWindow },
      'Package downloads fetched',
    );
  }
  return weekly;
}

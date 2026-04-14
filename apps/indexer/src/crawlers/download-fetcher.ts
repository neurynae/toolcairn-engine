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
 * Verify that a package on a registry belongs to this GitHub repo.
 * Checks if the package's repository/homepage URL contains the owner/repo.
 */
async function verifyOwnership(
  registry: string,
  packageName: string,
  ownerName: string,
  repoName: string,
): Promise<boolean> {
  const config = REGISTRY_CONFIGS[registry];
  if (!config?.metadataUrl || !config.repoUrlField) {
    // No verification possible — trust the README match
    return true;
  }

  try {
    const url = config.metadataUrl.replace('{pkg}', encodeURIComponent(packageName));
    const resp = await fetch(url, {
      headers: config.headers ?? {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) return false;

    const data = await resp.json();
    const repoUrlValue = getNestedField(data, config.repoUrlField);

    // The repo URL field might be a string or an object (PyPI's project_urls is a dict)
    const urlsToCheck: string[] = [];
    if (typeof repoUrlValue === 'string') {
      urlsToCheck.push(repoUrlValue);
    } else if (typeof repoUrlValue === 'object' && repoUrlValue !== null) {
      // PyPI project_urls: { "Homepage": "...", "Source": "...", "Repository": "..." }
      urlsToCheck.push(...Object.values(repoUrlValue as Record<string, string>));
    }

    const ownerRepo = `${ownerName}/${repoName}`.toLowerCase();
    return urlsToCheck.some((u) => typeof u === 'string' && u.toLowerCase().includes(ownerRepo));
  } catch {
    // Verification failed — be conservative, don't trust the match
    return false;
  }
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
    const resp = await fetch(url, {
      headers: config.headers ?? {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) return null;

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
    const resp = await fetch(
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json;api-version=3.0-preview.1',
          'Content-Type': 'application/json',
        },
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      },
    );
    if (!resp.ok) return null;

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
    const resp = await fetch(
      `https://formulae.brew.sh/api/formula/${encodeURIComponent(formulaName)}.json`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
    );
    if (!resp.ok) return null;

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
      // Verify ownership first (for registries with metadata API)
      const verified = await verifyOwnership(ch.registry, ch.packageName, ownerName, repoName);
      if (!verified) {
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

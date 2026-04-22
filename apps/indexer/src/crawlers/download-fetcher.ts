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
 * Per-registry verification outcome.
 * - `verified` — registry API returned a repo URL that matches `<owner>/<repo>`.
 * - `unverifiable` — registry has no metadataUrl/repoUrlField in config; we can't
 *   cross-check. Upstream decides whether to trust the README match.
 * - `rejected` — registry said NO (either repo URL doesn't match, 404, or fetch error).
 */
export type OwnershipVerdict = 'verified' | 'unverifiable' | 'rejected';

/**
 * Cross-check whether a `(registry, packageName)` channel belongs to the given
 * `<owner>/<repo>` by hitting the registry's own metadata API and comparing
 * repoUrlField back against the tool's GitHub identity.
 *
 * Returns a 3-way verdict so callers can distinguish "registry says no"
 * (reject the channel) from "we can't tell" (trust the README match because
 * some registries lack a metadata API — hackage, cpan, luarocks, nimble,
 * opam, vcpkg, conan, spm, elm, nix, cran, clojars, terraform, ansible,
 * puppet, chef, flathub, wordpress, vscode, julia, cocoapods).
 */
export async function verifyChannelOwnership(
  registry: string,
  packageName: string,
  ownerName: string,
  repoName: string,
): Promise<OwnershipVerdict> {
  const config = REGISTRY_CONFIGS[registry];
  if (!config?.metadataUrl || !config.repoUrlField) {
    return 'unverifiable';
  }

  try {
    const url = config.metadataUrl.replace('{pkg}', encodeURIComponent(packageName));
    const resp = await fetch(url, {
      headers: config.headers ?? {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) return 'rejected';

    const data = await resp.json();
    const repoUrlValue = getNestedField(data, config.repoUrlField);

    // The repo URL field might be a string or an object (PyPI's project_urls is a dict;
    // hex has meta.links; packagist has package.repository as a string).
    const urlsToCheck: string[] = [];
    if (typeof repoUrlValue === 'string') {
      urlsToCheck.push(repoUrlValue);
    } else if (typeof repoUrlValue === 'object' && repoUrlValue !== null) {
      urlsToCheck.push(...Object.values(repoUrlValue as Record<string, string>));
    }

    const ownerRepo = `${ownerName}/${repoName}`.toLowerCase();
    const matches = urlsToCheck.some(
      (u) => typeof u === 'string' && u.toLowerCase().includes(ownerRepo),
    );
    return matches ? 'verified' : 'rejected';
  } catch {
    // Network / parse error — be conservative and reject.
    return 'rejected';
  }
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
 * Verify every discovered channel against its registry's metadata API, drop
 * the ones the registry explicitly disowns (`rejected`), and enrich the
 * survivors with download counts where available.
 *
 * Unlike `fetchAllDownloadCounts`, this function covers channels that DON'T
 * have a download API (go, spm, vcpkg, conan, etc.) — those get verified
 * when possible and otherwise pass through as `unverifiable`. It's the
 * authoritative filter for constructing `Tool.package_managers`.
 *
 * Return order preserves input order. Rejected channels are filtered out.
 */
export async function verifyAndFetchAllChannels(
  channels: DiscoveredPackage[],
  ownerName: string,
  repoName: string,
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
      );
      if (verdict === 'rejected') {
        logger.debug(
          { registry: ch.registry, pkg: ch.packageName, owner: ownerName, repo: repoName },
          'Channel rejected by registry — dropping from package_managers',
        );
        return null;
      }

      let weekly = 0;
      const cfg = REGISTRY_CONFIGS[ch.registry];
      if (cfg?.hasDownloadApi) {
        const dl = await fetchRegistryDownloads(ch.registry, ch.packageName);
        if (dl) {
          weekly = convertToWeeklyEquivalent(dl.downloads, dl.timeWindow, dl.createdAt);
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

import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

interface PackagistVersionRow {
  version?: string;
  version_normalized?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  time?: string;
  abandoned?: boolean | string;
}

interface PackagistResponse {
  package?: {
    name?: string;
    versions?: Record<string, PackagistVersionRow>;
  };
}

/** Pick the newest stable tag from the packagist versions map. */
function pickLatest(versions: Record<string, PackagistVersionRow>): string | null {
  const keys = Object.keys(versions);
  if (!keys.length) return null;
  const stable = keys.filter((k) => /^v?\d/.test(k) && !/-(dev|alpha|beta|rc)/i.test(k));
  const list = stable.length ? stable : keys;
  return list.sort().reverse()[0] ?? null;
}

/**
 * Packagist ships every version's full manifest (require + require-dev) inline
 * on the /packages/{vendor}/{name}.json endpoint — free per-version deps for
 * the whole history. We extract the top N by recency (time field), latest first.
 */
export function extractPackagist(ctx: VersionExtractorContext): VersionMetadata[] {
  const raw = ctx.raw as PackagistResponse | null;
  const versions = raw?.package?.versions;
  if (!versions) return [];
  const latestKey = pickLatest(versions);
  if (!latestKey) return [];

  const sorted = Object.entries(versions)
    .map(([key, row]) => ({ key, row }))
    .sort((a, b) => {
      const ta = a.row.time ? Date.parse(a.row.time) : 0;
      const tb = b.row.time ? Date.parse(b.row.time) : 0;
      return tb - ta;
    });

  // Pin "latest" to index 0 regardless of date (dist-tag semantics).
  const latestIdx = sorted.findIndex((s) => s.key === latestKey);
  if (latestIdx > 0) {
    const [row] = sorted.splice(latestIdx, 1);
    if (row) sorted.unshift(row);
  }

  return sorted.map(({ key, row }) => {
    const peers: PeerConstraint[] = [
      ...dictToPeers(row.require, 'composer', 'peer').filter(
        (p) => !p.packageName.startsWith('ext-') && p.packageName !== 'php',
      ),
      ...dictToPeers(row['require-dev'], 'composer', 'optional_peer'),
    ];
    const phpConstraint = row.require?.php;
    return {
      registry: 'packagist',
      packageName: ctx.packageName,
      version: key.replace(/^v/, ''),
      releaseDate: row.time ?? '',
      isStable: !/-(dev|alpha|beta|rc)/i.test(key),
      deprecated: Boolean(row.abandoned),
      source: 'declared_dependency',
      peers,
      engines: phpConstraint
        ? [{ runtime: 'php', range: phpConstraint, rangeSystem: 'composer' }]
        : [],
    };
  });
}

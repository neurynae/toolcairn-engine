import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

const logger = createLogger({ name: '@toolcairn/indexer:npm-extractor' });

interface NpmVersionEntry {
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  deprecated?: string | false;
}

interface NpmPackument {
  name?: string;
  versions?: Record<string, NpmVersionEntry>;
  'dist-tags'?: { latest?: string };
  time?: Record<string, string>;
  // Single-version latest response (/latest endpoint) — legacy fallback shape.
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
}

/**
 * npm — handles two response shapes:
 * 1. Full packument (`/{pkg}` without `/latest`) — preferred; contains history.
 * 2. Latest-only packet (`/{pkg}/latest`) — legacy fallback; single version.
 *
 * Packument path produces up to N recent versions, latest first. Optional peers
 * (`peerDependenciesMeta[X].optional === true`) tagged as `optional_peer`.
 */
export async function extractNpm(ctx: VersionExtractorContext): Promise<VersionMetadata[]> {
  const raw = ctx.raw as NpmPackument | null;
  if (!raw || typeof raw !== 'object') return [];

  // Shape 1: full packument (has `versions` map + `dist-tags`).
  if (raw.versions && typeof raw.versions === 'object') {
    return buildFromPackument(ctx, raw);
  }

  // Shape 2: single-version `/latest` response — produce a one-element array.
  if (typeof raw.version === 'string' && raw.version) {
    return [buildFromLatest(ctx, raw)];
  }

  return [];
}

function buildFromPackument(ctx: VersionExtractorContext, raw: NpmPackument): VersionMetadata[] {
  const versionsMap = raw.versions ?? {};
  const latestTag = raw['dist-tags']?.latest;
  const times = raw.time ?? {};

  const keys = Object.keys(versionsMap);
  if (!keys.length) return [];

  // Sort by release time if available, otherwise by natural version ordering.
  // Latest dist-tag is pinned to index 0 regardless of date.
  keys.sort((a, b) => {
    const ta = times[a] ? Date.parse(times[a]) : 0;
    const tb = times[b] ? Date.parse(times[b]) : 0;
    return tb - ta;
  });
  if (latestTag && keys.includes(latestTag)) {
    const idx = keys.indexOf(latestTag);
    if (idx > 0) {
      keys.splice(idx, 1);
      keys.unshift(latestTag);
    }
  }

  const out: VersionMetadata[] = [];
  for (const version of keys) {
    const entry = versionsMap[version];
    if (!entry) continue;
    try {
      out.push(entryToMetadata(ctx, version, entry, times[version] ?? ''));
    } catch (e) {
      logger.debug(
        { err: e, pkg: ctx.packageName, version },
        'Skipping malformed npm version entry',
      );
    }
  }
  return out;
}

function buildFromLatest(ctx: VersionExtractorContext, raw: NpmPackument): VersionMetadata {
  const version = raw.version as string;
  return entryToMetadata(
    ctx,
    version,
    {
      peerDependencies: raw.peerDependencies,
      peerDependenciesMeta: raw.peerDependenciesMeta,
      engines: raw.engines,
    },
    '',
  );
}

function entryToMetadata(
  ctx: VersionExtractorContext,
  version: string,
  entry: NpmVersionEntry,
  releaseDate: string,
): VersionMetadata {
  const peersRaw = dictToPeers(entry.peerDependencies, 'semver', 'peer');
  const optional = entry.peerDependenciesMeta ?? {};
  const peers: PeerConstraint[] = peersRaw.map((p) =>
    optional[p.packageName]?.optional ? { ...p, kind: 'optional_peer' } : p,
  );
  return {
    registry: 'npm',
    packageName: ctx.packageName,
    version,
    releaseDate,
    isStable: !/[-+]/.test(version),
    deprecated: typeof entry.deprecated === 'string' && entry.deprecated.length > 0,
    source: 'declared_dependency',
    peers,
    engines: Object.entries(entry.engines ?? {})
      .filter(([, range]) => typeof range === 'string' && range.trim())
      .map(([runtime, range]) => ({ runtime, range, rangeSystem: 'semver' as const })),
  };
}

import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

interface NpmPackument {
  name?: string;
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  deprecated?: string | false;
  time?: Record<string, string>;
}

/**
 * npm — peerDependencies + engines come back inside the /latest metadata payload.
 * Optional peers (`peerDependenciesMeta[X].optional === true`) are tagged as
 * 'optional_peer' so the handler can treat range mismatches as `unknown` not `conflicts`.
 */
export function extractNpm(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as NpmPackument | null;
  if (!raw || typeof raw !== 'object') return null;
  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!version) return null;

  const peersRaw = dictToPeers(raw.peerDependencies, 'semver', 'peer');
  const optional = raw.peerDependenciesMeta ?? {};
  const peers: PeerConstraint[] = peersRaw.map((p) =>
    optional[p.packageName]?.optional ? { ...p, kind: 'optional_peer' } : p,
  );

  return {
    registry: 'npm',
    packageName: ctx.packageName,
    version,
    releaseDate: raw.time?.[version] ?? '',
    isStable: !/[-+]/.test(version),
    deprecated: typeof raw.deprecated === 'string' && raw.deprecated.length > 0,
    source: 'declared_dependency',
    peers,
    engines: Object.entries(raw.engines ?? {})
      .filter(([, range]) => typeof range === 'string' && range.trim())
      .map(([runtime, range]) => ({ runtime, range, rangeSystem: 'semver' as const })),
  };
}

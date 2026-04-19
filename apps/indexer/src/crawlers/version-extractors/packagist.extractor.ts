import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

interface PackagistResponse {
  package?: {
    name?: string;
    versions?: Record<
      string,
      {
        version_normalized?: string;
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
        time?: string;
        abandoned?: boolean | string;
      }
    >;
  };
}

function pickLatestVersion(
  versions: NonNullable<NonNullable<PackagistResponse['package']>['versions']>,
): string | null {
  const keys = Object.keys(versions);
  if (!keys.length) return null;
  const stable = keys.filter((k) => /^v?\d/.test(k) && !/-(dev|alpha|beta|rc)/i.test(k));
  const list = stable.length ? stable : keys;
  return list.sort().reverse()[0] ?? null;
}

export function extractPackagist(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as PackagistResponse | null;
  const versions = raw?.package?.versions;
  if (!versions) return null;
  const latestKey = pickLatestVersion(versions);
  if (!latestKey) return null;
  const row = versions[latestKey];
  if (!row) return null;

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
    version: latestKey.replace(/^v/, ''),
    releaseDate: row.time ?? '',
    isStable: !/-(dev|alpha|beta|rc)/i.test(latestKey),
    deprecated: Boolean(row.abandoned),
    source: 'declared_dependency',
    peers,
    engines: phpConstraint
      ? [{ runtime: 'php', range: phpConstraint, rangeSystem: 'composer' }]
      : [],
  };
}

import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface RubyGemsResponse {
  name?: string;
  version?: string;
  version_created_at?: string;
  yanked?: boolean;
  dependencies?: {
    runtime?: Array<{ name: string; requirements: string }>;
    development?: Array<{ name: string; requirements: string }>;
  };
}

/**
 * RubyGems returns dependencies split into runtime + development.
 * Development deps map to 'optional_peer' so they don't cause false-positive
 * conflicts in the compatibility handler.
 */
export function extractRubyGems(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as RubyGemsResponse | null;
  if (!raw) return null;
  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!version) return null;

  const peers: PeerConstraint[] = [];
  for (const dep of raw.dependencies?.runtime ?? []) {
    if (!dep?.name || !dep.requirements) continue;
    peers.push({
      packageName: dep.name,
      range: dep.requirements,
      rangeSystem: 'ruby',
      kind: 'peer',
    });
  }
  for (const dep of raw.dependencies?.development ?? []) {
    if (!dep?.name || !dep.requirements) continue;
    peers.push({
      packageName: dep.name,
      range: dep.requirements,
      rangeSystem: 'ruby',
      kind: 'optional_peer',
    });
  }

  return {
    registry: 'rubygems',
    packageName: ctx.packageName,
    version,
    releaseDate: raw.version_created_at ?? '',
    isStable: !/[a-z]/i.test(version.replace(/\./g, '')),
    deprecated: raw.yanked === true,
    source: 'declared_dependency',
    peers,
    engines: [],
  };
}

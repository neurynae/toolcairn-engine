import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface HexResponse {
  name?: string;
  latest_version?: string;
  latest_stable_version?: string;
  releases?: Array<{ version?: string; inserted_at?: string; has_docs?: boolean }>;
  meta?: {
    requirements?: Record<string, { app?: string; optional?: boolean; requirement?: string }>;
  };
}

export function extractHex(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as HexResponse | null;
  if (!raw) return null;
  const version = raw.latest_stable_version ?? raw.latest_version ?? '';
  if (!version) return null;

  const peers: PeerConstraint[] = [];
  for (const [name, spec] of Object.entries(raw.meta?.requirements ?? {})) {
    if (!spec?.requirement) continue;
    peers.push({
      packageName: name,
      range: spec.requirement,
      rangeSystem: 'semver',
      kind: spec.optional ? 'optional_peer' : 'peer',
    });
  }

  const release = raw.releases?.find((r) => r.version === version);

  return {
    registry: 'hex',
    packageName: ctx.packageName,
    version,
    releaseDate: release?.inserted_at ?? '',
    isStable: !/-(rc|alpha|beta|dev)/i.test(version),
    source: 'declared_dependency',
    peers,
    engines: [],
  };
}

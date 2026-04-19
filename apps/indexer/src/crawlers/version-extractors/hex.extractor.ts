import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface HexResponse {
  name?: string;
  latest_version?: string;
  latest_stable_version?: string;
  releases?: Array<{ version?: string; inserted_at?: string }>;
  meta?: {
    requirements?: Record<string, { app?: string; optional?: boolean; requirement?: string }>;
  };
}

/**
 * Hex.pm /packages/{name} returns a `releases` list and a single `meta.requirements`
 * block — per-version deps aren't exposed here (require /packages/{name}/releases/{ver}
 * per version). MVP: latest version gets full requirements as edges; historic versions
 * are stored as 'version_only' nodes for pinned-version fallback.
 */
export function extractHex(ctx: VersionExtractorContext): VersionMetadata[] {
  const raw = ctx.raw as HexResponse | null;
  if (!raw) return [];
  const latest = raw.latest_stable_version ?? raw.latest_version ?? '';
  if (!latest) return [];

  const latestPeers: PeerConstraint[] = [];
  for (const [name, spec] of Object.entries(raw.meta?.requirements ?? {})) {
    if (!spec?.requirement) continue;
    latestPeers.push({
      packageName: name,
      range: spec.requirement,
      rangeSystem: 'semver',
      kind: spec.optional ? 'optional_peer' : 'peer',
    });
  }

  const sorted = [...(raw.releases ?? [])]
    .filter((r) => typeof r.version === 'string')
    .sort((a, b) => {
      const ta = a.inserted_at ? Date.parse(a.inserted_at) : 0;
      const tb = b.inserted_at ? Date.parse(b.inserted_at) : 0;
      return tb - ta;
    });

  const idx = sorted.findIndex((r) => r.version === latest);
  if (idx > 0) {
    const [row] = sorted.splice(idx, 1);
    if (row) sorted.unshift(row);
  } else if (idx < 0) {
    sorted.unshift({ version: latest, inserted_at: '' });
  }

  return sorted.map((r, i) => {
    const version = r.version as string;
    return {
      registry: 'hex',
      packageName: ctx.packageName,
      version,
      releaseDate: r.inserted_at ?? '',
      isStable: !/-(rc|alpha|beta|dev)/i.test(version),
      source: i === 0 ? 'declared_dependency' : 'version_only',
      peers: i === 0 ? latestPeers : [],
      engines: [],
    };
  });
}

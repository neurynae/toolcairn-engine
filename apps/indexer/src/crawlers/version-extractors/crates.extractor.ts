import type { VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface CratesVersionRow {
  num?: string;
  rust_version?: string;
  created_at?: string;
  yanked?: boolean;
}

interface CratesResponse {
  crate?: {
    name?: string;
    max_stable_version?: string;
    max_version?: string;
    updated_at?: string;
  };
  versions?: CratesVersionRow[];
}

/**
 * crates.io `/crates/{pkg}` response carries its top-N versions inline with
 * `created_at` + `rust_version` (MSRV → REQUIRES_RUNTIME edge to "rust").
 * Per-version deps aren't in this endpoint; fetching them requires a call to
 * /crates/{pkg}/{ver}/dependencies per version. Not worth the fan-out for MVP —
 * latest version carries full runtime data, historic versions are stored as
 * 'version_only' nodes for pinned-version lookup fallback.
 */
export function extractCrates(ctx: VersionExtractorContext): VersionMetadata[] {
  const raw = ctx.raw as CratesResponse | null;
  const versions = (raw?.versions ?? []).filter((v) => typeof v.num === 'string');
  if (!versions.length) return [];

  const latestName =
    raw?.crate?.max_stable_version ??
    raw?.crate?.max_version ??
    versions.find((v) => !v.yanked)?.num;

  // Sort by created_at desc, placing "latest" (dist-tag) first regardless.
  const sorted = [...versions].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });
  if (latestName) {
    const idx = sorted.findIndex((v) => v.num === latestName);
    if (idx > 0) {
      const [row] = sorted.splice(idx, 1);
      if (row) sorted.unshift(row);
    }
  }

  return sorted.map((v, i) => {
    const version = v.num as string;
    const rustVersion = v.rust_version?.trim();
    return {
      registry: 'crates',
      packageName: ctx.packageName,
      version,
      releaseDate: v.created_at ?? '',
      isStable: !/[-+]/.test(version),
      deprecated: v.yanked === true,
      // Only the latest version carries per-version MSRV as an edge source of
      // 'declared_dependency' — older rows are version_only (no edges).
      source: i === 0 ? 'declared_dependency' : 'version_only',
      peers: [],
      engines:
        i === 0 && rustVersion
          ? [{ runtime: 'rust', range: `>=${rustVersion}`, rangeSystem: 'cargo' }]
          : [],
    };
  });
}

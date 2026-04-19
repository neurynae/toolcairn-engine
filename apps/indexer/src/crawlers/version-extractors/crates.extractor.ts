import type { VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface CratesResponse {
  crate?: {
    name?: string;
    max_stable_version?: string;
    max_version?: string;
    updated_at?: string;
  };
  versions?: Array<{
    num?: string;
    rust_version?: string;
    created_at?: string;
    yanked?: boolean;
  }>;
}

/**
 * crates.io returns the top-N versions inline. We take the first non-yanked version
 * as "latest" and pull its rust-version (MSRV → REQUIRES_RUNTIME edge to "rust").
 * Per-version `deps` isn't in the inline response — fetching it requires another
 * call to /api/v1/crates/{pkg}/{ver}/dependencies. Deferred; Tier B deps.dev
 * covers Cargo dependency graphs if we need them.
 */
export function extractCrates(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as CratesResponse | null;
  const latestVersion =
    raw?.crate?.max_stable_version ??
    raw?.crate?.max_version ??
    raw?.versions?.find((v) => !v.yanked)?.num;
  if (!latestVersion) return null;

  const versionRow = raw?.versions?.find((v) => v.num === latestVersion);
  const rustVersion = versionRow?.rust_version?.trim();

  return {
    registry: 'crates',
    packageName: ctx.packageName,
    version: latestVersion,
    releaseDate: versionRow?.created_at ?? raw?.crate?.updated_at ?? '',
    isStable: !/[-+]/.test(latestVersion),
    deprecated: versionRow?.yanked === true,
    source: 'declared_dependency',
    peers: [],
    engines: rustVersion
      ? [{ runtime: 'rust', range: `>=${rustVersion}`, rangeSystem: 'cargo' }]
      : [],
  };
}

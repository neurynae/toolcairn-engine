import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';

interface PyPIResponse {
  info?: {
    name?: string;
    version?: string;
    requires_python?: string;
    requires_dist?: string[] | null;
    yanked?: boolean;
  };
  releases?: Record<
    string,
    Array<{ upload_time_iso_8601?: string; yanked?: boolean; requires_python?: string | null }>
  >;
}

/**
 * PEP 508 dep spec looks like: "asgiref (>=3.8.1,<4) ; python_version >= '3.10'"
 * We split on ';' to drop markers (env-conditional extras), keep main constraint.
 */
function parsePep508(expr: string): { name: string; range: string } | null {
  const main = expr.split(';')[0]?.trim();
  if (!main) return null;
  const m = main.match(/^([A-Za-z0-9_.\-]+)(?:\[[^\]]+\])?\s*(?:\(([^)]*)\)|(.*))$/);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  const rangeExpr = (m[2] ?? m[3] ?? '').trim();
  if (!name) return null;
  return { name, range: rangeExpr || '' };
}

/**
 * Extract the latest + historic versions. PyPI's /{pkg}/json response contains
 * a `releases` map keyed by every published version — but only the top-level
 * `info` block has requires_dist. Historic versions' declared deps aren't in
 * this endpoint (they require per-version calls to /{pkg}/{ver}/json).
 *
 * MVP behavior: latest version gets full peers/engines; historic versions get
 * release date + version only (source: 'version_only'). Pinned-version
 * compatibility queries for historic versions fall back to the legacy path.
 */
export function extractPyPI(ctx: VersionExtractorContext): VersionMetadata[] {
  const raw = ctx.raw as PyPIResponse | null;
  if (!raw?.info) return [];
  const latestVersion = typeof raw.info.version === 'string' ? raw.info.version : '';
  if (!latestVersion) return [];

  const latestPeers: PeerConstraint[] = [];
  for (const dep of raw.info.requires_dist ?? []) {
    const parsed = parsePep508(dep);
    if (!parsed || !parsed.range) continue;
    latestPeers.push({
      packageName: parsed.name,
      range: parsed.range,
      rangeSystem: 'pep440',
      kind: 'dep',
    });
  }

  const latestEngines =
    typeof raw.info.requires_python === 'string' && raw.info.requires_python.trim()
      ? [
          {
            runtime: 'python',
            range: raw.info.requires_python.trim(),
            rangeSystem: 'pep440' as const,
          },
        ]
      : [];

  const latestReleaseDate = raw.releases?.[latestVersion]?.[0]?.upload_time_iso_8601 ?? '';

  const out: VersionMetadata[] = [
    {
      registry: 'pypi',
      packageName: ctx.packageName,
      version: latestVersion,
      releaseDate: latestReleaseDate,
      isStable: !/[abrc]\d/i.test(latestVersion),
      deprecated: raw.info.yanked === true,
      source: 'declared_dependency',
      peers: latestPeers,
      engines: latestEngines,
    },
  ];

  // Historic versions — sort by upload time descending, cap later in dispatcher.
  const historic = Object.entries(raw.releases ?? {})
    .filter(([v]) => v !== latestVersion)
    .map(([version, files]) => ({
      version,
      uploaded: files?.[0]?.upload_time_iso_8601 ?? '',
      yanked: files?.[0]?.yanked === true,
    }))
    .sort((a, b) => {
      const ta = a.uploaded ? Date.parse(a.uploaded) : 0;
      const tb = b.uploaded ? Date.parse(b.uploaded) : 0;
      return tb - ta;
    });

  for (const h of historic) {
    out.push({
      registry: 'pypi',
      packageName: ctx.packageName,
      version: h.version,
      releaseDate: h.uploaded,
      isStable: !/[abrc]\d/i.test(h.version),
      deprecated: h.yanked,
      source: 'version_only',
      peers: [],
      engines: [],
    });
  }

  return out;
}

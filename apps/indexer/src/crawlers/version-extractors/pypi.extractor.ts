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
  releases?: Record<string, Array<{ upload_time_iso_8601?: string }>>;
}

/**
 * PEP 508 dep spec looks like: "asgiref (>=3.8.1,<4) ; python_version >= '3.10'"
 * We split on ';' to isolate marker (we drop markers in MVP — they model extras
 * and environment-conditional deps; main constraint is usable).
 * Strips `[extras]` and surrounding whitespace.
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

export function extractPyPI(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as PyPIResponse | null;
  if (!raw?.info) return null;
  const version = typeof raw.info.version === 'string' ? raw.info.version : '';
  if (!version) return null;

  const peers: PeerConstraint[] = [];
  for (const dep of raw.info.requires_dist ?? []) {
    const parsed = parsePep508(dep);
    if (!parsed || !parsed.range) continue;
    peers.push({
      packageName: parsed.name,
      range: parsed.range,
      rangeSystem: 'pep440',
      kind: 'dep',
    });
  }

  const engines =
    typeof raw.info.requires_python === 'string' && raw.info.requires_python.trim()
      ? [
          {
            runtime: 'python',
            range: raw.info.requires_python.trim(),
            rangeSystem: 'pep440' as const,
          },
        ]
      : [];

  const releaseArray = raw.releases?.[version] ?? [];
  const releaseDate = releaseArray[0]?.upload_time_iso_8601 ?? '';

  return {
    registry: 'pypi',
    packageName: ctx.packageName,
    version,
    releaseDate,
    isStable: !/[abrc]\d/i.test(version),
    deprecated: raw.info.yanked === true,
    source: 'declared_dependency',
    peers,
    engines,
  };
}

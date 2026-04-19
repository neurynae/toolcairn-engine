import type { VersionMetadata } from '@toolcairn/core';

/**
 * Generic extractor for Tier C registries where the metadata endpoint returns
 * a version string but no machine-readable dependency graph. Produces a single-
 * entry array (there's no history probe for these registries in MVP).
 *
 * Probes a set of common field names across registry shapes. Order of probes:
 * version → latest_version → latest.version → latest_release.version → crate.max_version.
 */
function extractVersionString(raw: Record<string, unknown> | null): {
  version: string;
  releaseDate: string;
} | null {
  if (!raw) return null;
  const candidates = [
    ['version'],
    ['latest_version'],
    ['latest', 'version'],
    ['latest_release', 'version'],
    ['crate', 'max_version'],
    ['info', 'version'],
  ];
  for (const path of candidates) {
    let v: unknown = raw;
    for (const seg of path) {
      if (v && typeof v === 'object' && seg in (v as Record<string, unknown>)) {
        v = (v as Record<string, unknown>)[seg];
      } else {
        v = undefined;
        break;
      }
    }
    if (typeof v === 'string' && v.trim()) {
      const dateProbes = ['updated_at', 'published_at', 'time', 'last_updated', 'date'];
      let date = '';
      for (const k of dateProbes) {
        const dv = (raw as Record<string, unknown>)[k];
        if (typeof dv === 'string') {
          date = dv;
          break;
        }
      }
      return { version: v.trim(), releaseDate: date };
    }
  }
  return null;
}

export function extractVersionOnly(ctx: {
  registry: string;
  packageName: string;
  raw: unknown;
}): VersionMetadata[] {
  const raw = (ctx.raw as Record<string, unknown>) ?? null;
  const found = extractVersionString(raw);
  if (!found) return [];
  return [
    {
      registry: ctx.registry,
      packageName: ctx.packageName,
      version: found.version,
      releaseDate: found.releaseDate,
      isStable: !/[-+]/.test(found.version),
      source: 'version_only',
      peers: [],
      engines: [],
    },
  ];
}

import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

interface PubPubspec {
  version?: string;
  dependencies?: Record<string, unknown>;
  dev_dependencies?: Record<string, unknown>;
  environment?: { sdk?: string; flutter?: string };
}

interface PubVersionRow {
  version?: string;
  pubspec?: PubPubspec;
  published?: string;
}

interface PubResponse {
  name?: string;
  latest?: PubVersionRow;
  versions?: PubVersionRow[];
}

function coerceDepRanges(dict: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dict ?? {})) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && 'version' in v && typeof v.version === 'string')
      out[k] = v.version;
  }
  return out;
}

function rowToMetadata(ctx: VersionExtractorContext, row: PubVersionRow): VersionMetadata | null {
  const version = row.version ?? row.pubspec?.version;
  if (!version) return null;
  const pubspec = row.pubspec ?? {};
  const peers: PeerConstraint[] = [
    ...dictToPeers(coerceDepRanges(pubspec.dependencies), 'semver', 'peer'),
    ...dictToPeers(coerceDepRanges(pubspec.dev_dependencies), 'semver', 'optional_peer'),
  ];
  const engines: VersionMetadata['engines'] = [];
  if (pubspec.environment?.sdk) {
    engines.push({
      runtime: 'dart',
      range: pubspec.environment.sdk,
      rangeSystem: 'semver',
    });
  }
  if (pubspec.environment?.flutter) {
    engines.push({
      runtime: 'flutter',
      range: pubspec.environment.flutter,
      rangeSystem: 'semver',
    });
  }
  return {
    registry: 'pub',
    packageName: ctx.packageName,
    version,
    releaseDate: row.published ?? '',
    isStable: !/[-+]/.test(version),
    source: 'declared_dependency',
    peers,
    engines,
  };
}

export function extractPub(ctx: VersionExtractorContext): VersionMetadata[] {
  const raw = ctx.raw as PubResponse | null;
  if (!raw) return [];
  const rows = raw.versions ?? (raw.latest ? [raw.latest] : []);
  if (!rows.length) return [];

  // Sort newest first; pin `latest` (if named) to index 0.
  const latestVer = raw.latest?.version;
  const sorted = [...rows].sort((a, b) => {
    const ta = a.published ? Date.parse(a.published) : 0;
    const tb = b.published ? Date.parse(b.published) : 0;
    return tb - ta;
  });
  if (latestVer) {
    const idx = sorted.findIndex((r) => r.version === latestVer);
    if (idx > 0) {
      const [row] = sorted.splice(idx, 1);
      if (row) sorted.unshift(row);
    }
  }

  const out: VersionMetadata[] = [];
  for (const row of sorted) {
    const meta = rowToMetadata(ctx, row);
    if (meta) out.push(meta);
  }
  return out;
}

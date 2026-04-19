import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import type { VersionExtractorContext } from './index.js';
import { dictToPeers } from './utils.js';

interface PubResponse {
  name?: string;
  latest?: {
    version?: string;
    pubspec?: {
      version?: string;
      dependencies?: Record<string, unknown>;
      dev_dependencies?: Record<string, unknown>;
      environment?: { sdk?: string; flutter?: string };
    };
    published?: string;
  };
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

export function extractPub(ctx: VersionExtractorContext): VersionMetadata | null {
  const raw = ctx.raw as PubResponse | null;
  const latest = raw?.latest;
  const version = latest?.version ?? latest?.pubspec?.version;
  if (!version) return null;

  const pubspec = latest?.pubspec ?? {};
  const peers: PeerConstraint[] = [
    ...dictToPeers(coerceDepRanges(pubspec.dependencies), 'semver', 'peer'),
    ...dictToPeers(coerceDepRanges(pubspec.dev_dependencies), 'semver', 'optional_peer'),
  ];

  const engines = [];
  if (pubspec.environment?.sdk) {
    engines.push({
      runtime: 'dart',
      range: pubspec.environment.sdk,
      rangeSystem: 'semver' as const,
    });
  }
  if (pubspec.environment?.flutter) {
    engines.push({
      runtime: 'flutter',
      range: pubspec.environment.flutter,
      rangeSystem: 'semver' as const,
    });
  }

  return {
    registry: 'pub',
    packageName: ctx.packageName,
    version,
    releaseDate: latest?.published ?? '',
    isStable: !/[-+]/.test(version),
    source: 'declared_dependency',
    peers,
    engines,
  };
}

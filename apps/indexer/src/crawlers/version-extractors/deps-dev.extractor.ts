import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { REGISTRY_CONFIGS } from '../registry-config.js';
import type { VersionExtractorContext } from './index.js';

const logger = createLogger({ name: '@toolcairn/indexer:deps-dev-extractor' });

interface DepsDevVersion {
  versionKey?: { system?: string; name?: string; version?: string };
  publishedAt?: string;
  isDefault?: boolean;
  relatedPackages?: Array<{
    relationType?: string;
    packageKey?: { system?: string; name?: string };
  }>;
}

interface DepsDevPackage {
  packageKey?: { system?: string; name?: string };
  versions?: DepsDevVersion[];
}

function rangeSystemForSystem(system: string): PeerConstraint['rangeSystem'] {
  switch (system.toUpperCase()) {
    case 'NPM':
      return 'semver';
    case 'PYPI':
      return 'pep440';
    case 'CARGO':
      return 'cargo';
    case 'MAVEN':
      return 'maven';
    case 'PACKAGIST':
      return 'composer';
    case 'GO':
      return 'semver';
    case 'NUGET':
      return 'semver';
    default:
      return 'opaque';
  }
}

/**
 * deps.dev `/v3/systems/{sys}/packages/{pkg}` returns all published versions
 * with `publishedAt` + `isDefault` + `relatedPackages` (dependency keys, no
 * ranges). We emit one VersionMetadata per version, latest (isDefault) first.
 *
 * Dependency ranges aren't exposed here — edges get `range: "*"`. A follow-up
 * could call /versions/{ver}:dependencies per version for rich constraints.
 */
export async function extractDepsDev(ctx: VersionExtractorContext): Promise<VersionMetadata[]> {
  const cfg = REGISTRY_CONFIGS[ctx.registry];
  const system = cfg?.depsDevSystem;
  if (!system) return [];

  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(ctx.packageName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      logger.debug(
        { url, status: res.status, registry: ctx.registry },
        'deps.dev returned non-200',
      );
      return [];
    }
    const pkg = (await res.json()) as DepsDevPackage;
    const versions = pkg.versions ?? [];
    if (!versions.length) return [];

    const sorted = [...versions].sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    const defaultIdx = sorted.findIndex((v) => v.isDefault);
    if (defaultIdx > 0) {
      const [row] = sorted.splice(defaultIdx, 1);
      if (row) sorted.unshift(row);
    }

    return sorted
      .filter((row) => typeof row.versionKey?.version === 'string')
      .map((row) => {
        const version = row.versionKey?.version as string;
        const peers: PeerConstraint[] = [];
        for (const rel of row.relatedPackages ?? []) {
          const relName = rel.packageKey?.name;
          const relSys = rel.packageKey?.system ?? system;
          if (!relName) continue;
          if (rel.relationType === 'DEPENDS_ON' || rel.relationType === 'PEER_DEPENDENCY') {
            peers.push({
              packageName: relName,
              range: '*',
              rangeSystem: rangeSystemForSystem(relSys),
              kind: rel.relationType === 'PEER_DEPENDENCY' ? 'peer' : 'dep',
            });
          }
        }
        return {
          registry: ctx.registry,
          packageName: ctx.packageName,
          version,
          releaseDate: row.publishedAt ?? '',
          isStable: !/[-+]/.test(version),
          source: 'deps_dev' as const,
          peers,
          engines: [],
        };
      });
  } catch (e) {
    logger.debug({ err: e, url }, 'deps.dev fetch failed');
    return [];
  }
}

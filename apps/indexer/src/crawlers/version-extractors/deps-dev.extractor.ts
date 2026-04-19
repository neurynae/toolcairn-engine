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
 * deps.dev unified API — one GET for the package, we pick the default version
 * and extract dependency keys as peers. Dependency ranges aren't exposed in
 * the package-level endpoint; we record dep edges without ranges (range = '*').
 * For richer data (actual constraint strings) a follow-up call to
 * /v3/systems/{s}/packages/{p}/versions/{v}:dependencies is needed.
 */
export async function extractDepsDev(
  ctx: VersionExtractorContext,
): Promise<VersionMetadata | null> {
  const cfg = REGISTRY_CONFIGS[ctx.registry];
  const system = cfg?.depsDevSystem;
  if (!system) return null;

  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(ctx.packageName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      logger.debug(
        { url, status: res.status, registry: ctx.registry },
        'deps.dev returned non-200',
      );
      return null;
    }
    const pkg = (await res.json()) as DepsDevPackage;
    const defaultVersion =
      pkg.versions?.find((v) => v.isDefault)?.versionKey ?? pkg.versions?.[0]?.versionKey;
    const version = defaultVersion?.version;
    if (!version) return null;

    const row = pkg.versions?.find((v) => v.versionKey?.version === version);
    const peers: PeerConstraint[] = [];
    for (const rel of row?.relatedPackages ?? []) {
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
      releaseDate: row?.publishedAt ?? '',
      isStable: !/[-+]/.test(version),
      source: 'deps_dev',
      peers,
      engines: [],
    };
  } catch (e) {
    logger.debug({ err: e, url }, 'deps.dev fetch failed');
    return null;
  }
}

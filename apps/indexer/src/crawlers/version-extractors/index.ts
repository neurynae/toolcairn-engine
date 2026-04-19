import type { VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { REGISTRY_CONFIGS, type VersionExtractor } from '../registry-config.js';
import { extractCrates } from './crates.extractor.js';
import { extractDepsDev } from './deps-dev.extractor.js';
import { extractHex } from './hex.extractor.js';
import { extractNpm } from './npm.extractor.js';
import { extractPackagist } from './packagist.extractor.js';
import { extractPub } from './pub.extractor.js';
import { extractPyPI } from './pypi.extractor.js';
import { extractRubyGems } from './rubygems.extractor.js';
import { extractVersionOnly } from './version-only.extractor.js';

const logger = createLogger({ name: '@toolcairn/indexer:version-extractors' });

/**
 * Max historic versions extracted per tool. Upstream sort puts latest first, so
 * this is effectively "keep the most recent N releases." Edge count is bounded:
 * N versions * ~K peers each. Tests with N=15 and K~10 produce ~150 edges/tool,
 * Memgraph handles that comfortably at 12k-tool scale.
 */
export const MAX_VERSIONS_PER_TOOL = 15;

export interface VersionExtractorContext {
  /** Registry key (e.g. "npm", "pypi"). */
  registry: string;
  /** Package name inside the registry (e.g. "next", "django"). */
  packageName: string;
  /** Raw metadata response from the registry's metadataUrl. */
  raw: unknown;
}

/**
 * Dispatch to the right extractor based on registry-config mapping.
 *
 * Always returns an array — empty when no version data could be extracted,
 * otherwise ordered newest-first (caller relies on index [0] being latest).
 * Capped at MAX_VERSIONS_PER_TOOL entries. Never throws; failures degrade
 * to an empty array and upstream falls back to the legacy graph-edge path.
 */
export async function extractVersionMetadata(
  ctx: VersionExtractorContext,
): Promise<VersionMetadata[]> {
  const config = REGISTRY_CONFIGS[ctx.registry];
  if (!config) {
    logger.debug({ registry: ctx.registry }, 'Unknown registry — skipping version extraction');
    return [];
  }
  const extractor: VersionExtractor = config.versionExtractor ?? 'version_only';
  if (extractor === 'none') return [];

  try {
    switch (extractor) {
      case 'npm':
        return cap(await extractNpm(ctx));
      case 'pypi':
        return cap(extractPyPI(ctx));
      case 'crates':
        return cap(extractCrates(ctx));
      case 'rubygems':
        return cap(await extractRubyGems(ctx));
      case 'packagist':
        return cap(extractPackagist(ctx));
      case 'pub':
        return cap(extractPub(ctx));
      case 'hex':
        return cap(extractHex(ctx));
      case 'deps_dev':
        return cap(await extractDepsDev(ctx));
      case 'version_only':
        return cap(extractVersionOnly(ctx));
      default:
        return [];
    }
  } catch (e) {
    logger.warn(
      { err: e, registry: ctx.registry, packageName: ctx.packageName },
      'Version extractor threw',
    );
    return [];
  }
}

function cap(list: VersionMetadata[]): VersionMetadata[] {
  return list.slice(0, MAX_VERSIONS_PER_TOOL);
}

export { buildVersionId } from './utils.js';

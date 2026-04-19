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
 * Returns null when no version metadata could be extracted — never throws;
 * upstream handles graceful degradation.
 */
export async function extractVersionMetadata(
  ctx: VersionExtractorContext,
): Promise<VersionMetadata | null> {
  const config = REGISTRY_CONFIGS[ctx.registry];
  if (!config) {
    logger.debug({ registry: ctx.registry }, 'Unknown registry — skipping version extraction');
    return null;
  }
  const extractor: VersionExtractor = config.versionExtractor ?? 'version_only';
  if (extractor === 'none') return null;

  try {
    switch (extractor) {
      case 'npm':
        return extractNpm(ctx);
      case 'pypi':
        return extractPyPI(ctx);
      case 'crates':
        return extractCrates(ctx);
      case 'rubygems':
        return extractRubyGems(ctx);
      case 'packagist':
        return extractPackagist(ctx);
      case 'pub':
        return extractPub(ctx);
      case 'hex':
        return extractHex(ctx);
      case 'deps_dev':
        return await extractDepsDev(ctx);
      case 'version_only':
        return extractVersionOnly(ctx);
      default:
        return null;
    }
  } catch (e) {
    // Never throw from an extractor — graceful fallback to no-version-data.
    logger.warn(
      { err: e, registry: ctx.registry, packageName: ctx.packageName },
      'Version extractor threw',
    );
    return null;
  }
}

export { buildVersionId } from './utils.js';

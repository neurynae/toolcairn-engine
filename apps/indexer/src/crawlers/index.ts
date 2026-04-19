import type { VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { IndexerError } from '../errors.js';
import type { CrawlerResult } from '../types.js';
import { crawlCratesIoPackage } from './crates-io.js';
import { crawlGitHubRepo } from './github.js';
import { crawlNpmPackage } from './npm.js';
import { crawlPyPiPackage } from './pypi.js';
import { REGISTRY_CONFIGS } from './registry-config.js';
import { fetchRegistryMetadata } from './registry-metadata-fetcher.js';
import { extractVersionMetadata } from './version-extractors/index.js';

const logger = createLogger({ name: '@toolcairn/indexer:run-crawler' });

function registryKeyFor(source: CrawlerResult['source']): string | null {
  switch (source) {
    case 'npm':
      return 'npm';
    case 'pypi':
      return 'pypi';
    case 'crates.io':
      return 'crates';
    default:
      return null;
  }
}

/**
 * Dispatcher that routes to the appropriate crawler based on the source.
 * - github: url is "owner/repo" format
 * - npm: url is the package name
 * - pypi: url is the package name
 * - crates.io: url is the package name
 *
 * Post-crawl, invokes the version extractor registered for that source and
 * attaches VersionMetadata to the result so the queue consumer can write
 * Version nodes + edges without re-fetching.
 */
export async function runCrawler(
  source: CrawlerResult['source'],
  url: string,
): Promise<CrawlerResult> {
  let result: CrawlerResult;
  switch (source) {
    case 'github': {
      const parts = url.split('/');
      const owner = parts[0];
      const repo = parts[1];
      if (!owner || !repo) {
        throw new IndexerError({
          message: `Invalid GitHub URL format: "${url}" — expected "owner/repo"`,
        });
      }
      result = await crawlGitHubRepo(owner, repo);
      break;
    }
    case 'npm': {
      result = await crawlNpmPackage(url);
      break;
    }
    case 'pypi': {
      result = await crawlPyPiPackage(url);
      break;
    }
    case 'crates.io': {
      result = await crawlCratesIoPackage(url);
      break;
    }
    default: {
      const exhaustive: never = source;
      throw new IndexerError({ message: `Unknown crawler source: ${String(exhaustive)}` });
    }
  }

  const registry = registryKeyFor(result.source);
  if (registry) {
    const metas = await extractVersionMetadata({ registry, packageName: url, raw: result.raw });
    if (metas.length) result.versionMetadata = metas;
  } else if (result.source === 'github') {
    // GitHub-sourced tool — fetch metadata for each detected channel and run
    // the registered extractor. Bounded I/O: 1 fetch per channel (typical 0-2).
    const collected: VersionMetadata[] = [];
    for (const channel of result.extracted.package_managers) {
      const cfg = REGISTRY_CONFIGS[channel.registry];
      if (!cfg) continue;
      if (cfg.versionExtractor === 'none') continue;
      const raw = await fetchRegistryMetadata(channel.registry, channel.packageName);
      if (raw === null && cfg.versionExtractor !== 'deps_dev') continue;
      try {
        const metas = await extractVersionMetadata({
          registry: channel.registry,
          packageName: channel.packageName,
          raw,
        });
        collected.push(...metas);
      } catch (e) {
        logger.debug(
          { err: e, registry: channel.registry, pkg: channel.packageName },
          'per-channel version extraction threw — skipping',
        );
      }
    }
    if (collected.length) result.versionMetadata = collected;
  }
  return result;
}

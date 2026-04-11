import { IndexerError } from '../errors.js';
import type { CrawlerResult } from '../types.js';
import { crawlCratesIoPackage } from './crates-io.js';
import { crawlGitHubRepo } from './github.js';
import { crawlNpmPackage } from './npm.js';
import { crawlPyPiPackage } from './pypi.js';

/**
 * Dispatcher that routes to the appropriate crawler based on the source.
 * - github: url is "owner/repo" format
 * - npm: url is the package name
 * - pypi: url is the package name
 * - crates.io: url is the package name
 */
export async function runCrawler(
  source: CrawlerResult['source'],
  url: string,
): Promise<CrawlerResult> {
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
      return crawlGitHubRepo(owner, repo);
    }
    case 'npm': {
      return crawlNpmPackage(url);
    }
    case 'pypi': {
      return crawlPyPiPackage(url);
    }
    case 'crates.io': {
      return crawlCratesIoPackage(url);
    }
    default: {
      const exhaustive: never = source;
      throw new IndexerError({ message: `Unknown crawler source: ${String(exhaustive)}` });
    }
  }
}

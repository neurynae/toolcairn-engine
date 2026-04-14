import { createLogger } from '@toolcairn/errors';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';
import { enrichDescription } from './description-enricher.js';
import { fetchPackageDownloads } from './download-fetcher.js';
import { extractDocsUrl } from './readme-parser.js';

const logger = createLogger({ name: '@toolcairn/indexer:npm-crawler' });

interface NpmPackageResponse {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  homepage?: unknown;
  license?: unknown;
  repository?: unknown;
  keywords?: unknown;
  readme?: unknown;
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractRepositoryUrl(repository: unknown): string {
  if (typeof repository === 'string') return repository;
  if (typeof repository === 'object' && repository !== null && 'url' in repository) {
    return extractString((repository as Record<string, unknown>).url);
  }
  return '';
}

export async function crawlNpmPackage(name: string): Promise<CrawlerResult> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;

  try {
    logger.info({ name }, 'Crawling npm package');

    const response = await fetch(url);
    if (!response.ok) {
      throw new IndexerError({ message: `npm registry returned ${response.status} for ${name}` });
    }

    const raw: NpmPackageResponse = (await response.json()) as NpmPackageResponse;

    const keywords = Array.isArray((raw as Record<string, unknown>).keywords)
      ? ((raw as Record<string, unknown>).keywords as string[])
      : [];

    const pkgName = extractString(raw.name) || name;
    const description = extractString(raw.description);
    const homepage = extractString(raw.homepage);
    const license = extractString(raw.license) || 'unknown';
    const repoUrl = extractRepositoryUrl(raw.repository);
    const readme = extractString(raw.readme);

    const githubUrl = repoUrl
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace('git://', 'https://');

    // README parsing gives the most targeted docs URL (e.g. the API reference page).
    // Fall back to homepage only when it's clearly a docs/non-GitHub site.
    const readmeDocsUrl = readme ? extractDocsUrl(readme) : undefined;
    const homepageDocsUrl = homepage && !homepage.includes('github.com') ? homepage : undefined;
    const docsUrl = readmeDocsUrl ?? homepageDocsUrl;

    const extracted: ExtractedToolData = {
      name: pkgName,
      display_name: pkgName,
      description: enrichDescription(description, keywords),
      github_url: githubUrl || `https://www.npmjs.com/package/${name}`,
      homepage_url: homepage || undefined,
      docs_url: docsUrl,
      license,
      language: 'JavaScript',
      languages: ['JavaScript', 'TypeScript'],
      package_managers: { npm: name },
      deployment_models: ['self-hosted'],
    };

    // Fetch weekly downloads via unified REGISTRY_CONFIGS (non-fatal)
    const weeklyDownloads = await fetchPackageDownloads('npm', name);

    return {
      source: 'npm',
      url,
      raw: {
        ...raw,
        topics: keywords,
        weekly_downloads: weeklyDownloads,
      },
      extracted,
    };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Failed to crawl npm package ${name}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

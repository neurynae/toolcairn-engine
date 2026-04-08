import pino from 'pino';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';

const logger = pino({ name: '@toolcairn/indexer:npm-crawler' });

interface NpmPackageResponse {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  homepage?: unknown;
  license?: unknown;
  repository?: unknown;
  keywords?: unknown;
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
      throw new IndexerError(`npm registry returned ${response.status} for ${name}`);
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

    const githubUrl = repoUrl
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace('git://', 'https://');

    const extracted: ExtractedToolData = {
      name: pkgName,
      display_name: pkgName,
      description,
      github_url: githubUrl || `https://www.npmjs.com/package/${name}`,
      homepage_url: homepage || undefined,
      license,
      language: 'JavaScript',
      languages: ['JavaScript', 'TypeScript'],
      package_managers: { npm: name },
      deployment_models: ['self-hosted'],
    };

    return {
      source: 'npm',
      url,
      raw: { ...raw, topics: keywords },
      extracted,
    };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Failed to crawl npm package ${name}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

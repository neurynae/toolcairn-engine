import pino from 'pino';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';

const logger = pino({ name: '@toolcairn/indexer:pypi-crawler' });

interface PyPiInfo {
  name?: unknown;
  summary?: unknown;
  home_page?: unknown;
  license?: unknown;
  project_urls?: unknown;
  author?: unknown;
}

interface PyPiResponse {
  info?: PyPiInfo;
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractGitHubUrl(info: PyPiInfo): string {
  const projectUrls = info.project_urls;
  if (typeof projectUrls === 'object' && projectUrls !== null) {
    const urls = projectUrls as Record<string, unknown>;
    for (const key of Object.keys(urls)) {
      const val = extractString(urls[key]);
      if (val.includes('github.com')) return val;
    }
  }
  return extractString(info.home_page);
}

export async function crawlPyPiPackage(name: string): Promise<CrawlerResult> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

  try {
    logger.info({ name }, 'Crawling PyPI package');

    const response = await fetch(url);
    if (!response.ok) {
      throw new IndexerError(`PyPI returned ${response.status} for ${name}`);
    }

    const raw: PyPiResponse = (await response.json()) as PyPiResponse;
    const info: PyPiInfo = raw.info ?? {};

    const classifiers = Array.isArray((info as Record<string, unknown>).classifiers)
      ? ((info as Record<string, unknown>).classifiers as string[])
      : [];
    const topics = classifiers
      .filter((c: string) => c.startsWith('Topic ::'))
      .map((c: string) => c.split('::').pop()?.trim().toLowerCase().replace(/\s+/g, '-') ?? '')
      .filter(Boolean);

    const pkgName = extractString(info.name) || name;
    const description = extractString(info.summary);
    const homePage = extractString(info.home_page);
    const license = extractString(info.license) || 'unknown';
    const githubUrl = extractGitHubUrl(info);

    const extracted: ExtractedToolData = {
      name: pkgName,
      display_name: pkgName,
      description,
      github_url: githubUrl || `https://pypi.org/project/${name}`,
      homepage_url: homePage || undefined,
      license,
      language: 'Python',
      languages: ['Python'],
      package_managers: { pip: name },
      deployment_models: ['self-hosted'],
    };

    return {
      source: 'pypi',
      url,
      raw: { ...raw, topics },
      extracted,
    };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError(
      `Failed to crawl PyPI package ${name}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

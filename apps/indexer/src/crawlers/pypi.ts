import { createLogger } from '@toolcairn/errors';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';
import { enrichDescription } from './description-enricher.js';

const logger = createLogger({ name: '@toolcairn/indexer:pypi-crawler' });

interface PyPiInfo {
  name?: unknown;
  summary?: unknown;
  home_page?: unknown;
  docs_url?: unknown;
  license?: unknown;
  project_urls?: unknown;
  keywords?: unknown;
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

const DOC_KEYS = ['documentation', 'docs', 'doc'];
const CHANGELOG_KEYS = ['changelog', 'changes', 'release notes', 'history', "what's new"];

function extractProjectUrl(projectUrls: unknown, keys: string[]): string {
  if (typeof projectUrls !== 'object' || projectUrls === null) return '';
  const urls = projectUrls as Record<string, unknown>;
  for (const key of Object.keys(urls)) {
    if (keys.includes(key.toLowerCase())) {
      return extractString(urls[key]);
    }
  }
  return '';
}

export async function crawlPyPiPackage(name: string): Promise<CrawlerResult> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

  try {
    logger.info({ name }, 'Crawling PyPI package');

    const response = await fetch(url);
    if (!response.ok) {
      throw new IndexerError({ message: `PyPI returned ${response.status} for ${name}` });
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
    const rawDescription = extractString(info.summary);
    const homePage = extractString(info.home_page);

    // PyPI keywords field (comma-separated or already tokenized)
    const pypiKeywords = extractString(info.keywords)
      .split(/[,\s]+/)
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 1);
    const description = enrichDescription(rawDescription, [...pypiKeywords, ...topics]);
    const license = extractString(info.license) || 'unknown';
    const githubUrl = extractGitHubUrl(info);

    const pypiDocsUrl = extractString(info.docs_url);
    const projectUrlsDocsUrl = extractProjectUrl(info.project_urls, DOC_KEYS);
    const docsUrl = pypiDocsUrl || projectUrlsDocsUrl || undefined;
    const changelogUrl = extractProjectUrl(info.project_urls, CHANGELOG_KEYS) || undefined;

    const extracted: ExtractedToolData = {
      name: pkgName,
      display_name: pkgName,
      description,
      github_url: githubUrl || `https://pypi.org/project/${name}`,
      homepage_url: homePage || undefined,
      docs_url: docsUrl,
      changelog_url: changelogUrl,
      license,
      language: 'Python',
      languages: ['Python'],
      package_managers: { pip: name },
      deployment_models: ['self-hosted'],
    };

    // Fetch weekly download count from PyPI Stats API (non-fatal)
    let weeklyDownloads = 0;
    try {
      const dlRes = await fetch(
        `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (dlRes.ok) {
        const dlData = (await dlRes.json()) as { data?: { last_week?: number } };
        weeklyDownloads = dlData.data?.last_week ?? 0;
      }
    } catch {
      // Non-fatal — leave as 0
    }

    return {
      source: 'pypi',
      url,
      raw: { ...raw, topics, weekly_downloads: weeklyDownloads },
      extracted,
    };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Failed to crawl PyPI package ${name}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

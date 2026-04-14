import { createLogger } from '@toolcairn/errors';
import { IndexerError } from '../errors.js';
import type { CrawlerResult, ExtractedToolData } from '../types.js';
import { enrichDescription } from './description-enricher.js';
import { fetchPackageDownloads } from './download-fetcher.js';

const logger = createLogger({ name: '@toolcairn/indexer:crates-io-crawler' });

// crates.io requires a descriptive User-Agent per policy
const USER_AGENT = 'ToolPilot-Indexer/0.0.1 (https://github.com/toolpilot/toolpilot)';

interface CrateData {
  name?: unknown;
  description?: unknown;
  homepage?: unknown;
  documentation?: unknown;
  repository?: unknown;
  license?: unknown;
  newest_version?: unknown;
}

interface CratesIoResponse {
  crate?: CrateData;
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function crawlCratesIoPackage(name: string): Promise<CrawlerResult> {
  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;

  try {
    logger.info({ name }, 'Crawling crates.io package');

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new IndexerError({ message: `crates.io returned ${response.status} for ${name}` });
    }

    const raw: CratesIoResponse = (await response.json()) as CratesIoResponse;
    const crateData: CrateData = raw.crate ?? {};

    const categories = Array.isArray((crateData as Record<string, unknown>).categories)
      ? ((crateData as Record<string, unknown>).categories as string[])
      : [];
    const keywords = Array.isArray((crateData as Record<string, unknown>).keywords)
      ? ((crateData as Record<string, unknown>).keywords as string[])
      : [];
    const topics = [...categories, ...keywords];

    const pkgName = extractString(crateData.name) || name;
    const description = extractString(crateData.description);
    const homepage = extractString(crateData.homepage);
    const documentation = extractString(crateData.documentation);
    const repository = extractString(crateData.repository);
    const license = extractString(crateData.license) || 'unknown';

    // Prefer repository URL as github_url if it points to GitHub
    const githubUrl = repository.includes('github.com')
      ? repository
      : homepage.includes('github.com')
        ? homepage
        : repository || `https://crates.io/crates/${name}`;

    const extracted: ExtractedToolData = {
      name: pkgName,
      display_name: pkgName,
      description: enrichDescription(description, keywords),
      github_url: githubUrl,
      homepage_url: homepage || undefined,
      docs_url: documentation || undefined,
      license,
      language: 'Rust',
      languages: ['Rust'],
      package_managers: [
        { registry: 'crates', packageName: name, installCommand: `cargo add ${name}` },
      ],
      deployment_models: ['self-hosted'],
    };

    // Fetch downloads via unified REGISTRY_CONFIGS (non-fatal)
    const weeklyDownloads = await fetchPackageDownloads('crates', name);

    return {
      source: 'crates.io',
      url,
      raw: { ...raw, topics, weekly_downloads: weeklyDownloads },
      extracted,
    };
  } catch (e) {
    if (e instanceof IndexerError) throw e;
    throw new IndexerError({
      message: `Failed to crawl crates.io package ${name}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

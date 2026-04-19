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
  // Full packument — contains version history needed by the version extractor.
  // The packument's top-level tool-description fields are duplicated from the
  // latest version, so we synthesise the "latest view" locally after fetching.
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;

  try {
    logger.info({ name }, 'Crawling npm package');

    const response = await fetch(url);
    if (!response.ok) {
      throw new IndexerError({ message: `npm registry returned ${response.status} for ${name}` });
    }

    const packument = (await response.json()) as Record<string, unknown> & {
      'dist-tags'?: { latest?: string };
      versions?: Record<string, Record<string, unknown>>;
    };

    // Lift the latest version's manifest to the top level so all existing
    // extraction logic (description / homepage / license / repository / readme /
    // keywords) keeps working unchanged. Packument already has `readme` at the
    // top level for the latest version, so that's safe to reuse.
    const latestTag = packument['dist-tags']?.latest;
    const latestVersion =
      latestTag && packument.versions ? packument.versions[latestTag] : undefined;
    const raw = {
      ...(latestVersion ?? {}),
      ...packument,
    } as NpmPackageResponse & Record<string, unknown>;

    const keywords = Array.isArray(raw.keywords) ? (raw.keywords as string[]) : [];

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

    // Fetch weekly downloads via unified REGISTRY_CONFIGS (non-fatal)
    const weeklyDownloads = await fetchPackageDownloads('npm', name);

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
      package_managers: [
        {
          registry: 'npm',
          packageName: name,
          installCommand: `npm install ${name}`,
          weeklyDownloads,
        },
      ],
      deployment_models: ['self-hosted'],
    };

    return {
      source: 'npm',
      url,
      raw: {
        ...raw,
        topics: keywords,
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

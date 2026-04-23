/**
 * Canonical github_url resolver for a package name in any supported registry.
 *
 * Sits on top of `REGISTRY_CONFIGS` + `fetchRegistryMetadata` — the same
 * machinery the indexer uses during crawl-time channel verification
 * (`verifyChannelOwnership` in apps/indexer/src/crawlers/download-fetcher.ts).
 * The goal is to collapse that pattern into one reusable call so callers
 * outside the indexer (e.g. the `suggest_graph_update` engine handler) don't
 * need to reinvent the extraction logic.
 *
 * Input:  { ecosystem, packageName }
 * Output: authoritative https://github.com/<owner>/<repo> URL pulled straight
 *         from the registry's metadata, or null when the registry has no
 *         `repoUrlField` entry, the fetch fails, or the extracted value
 *         doesn't point at GitHub.
 *
 * Registries without `repoUrlField` (maven/gradle/swift-pm/etc.) return null
 * and the caller falls back to whatever URL the submitter provided.
 */
import { createLogger } from '@toolcairn/errors';
import { fetchRegistryMetadata } from './metadata-fetcher.js';
import { REGISTRY_CONFIGS } from './registry-config.js';

const logger = createLogger({ name: '@toolcairn/registry:canonical-url' });

/**
 * Read a dotted path from an object. `"foo.bar.baz"` walks `obj.foo?.bar?.baz`.
 * Returns `undefined` on any missing hop. Kept intentionally simple — the indexer
 * uses the same shape (see `getNestedField` in download-fetcher.ts line ~470).
 */
function getNestedField(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const key of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Normalise a raw repo URL shape to canonical `https://github.com/<owner>/<repo>`.
 * Handles the same variants as the client-side `url-normalise.ts` but with a
 * narrower contract (GitHub only — non-GitHub hosts return null here).
 */
function normaliseGithubUrl(raw: string): string | null {
  let cleaned = raw.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/^git\+/, '');
  cleaned = cleaned.replace(/^github:/, 'https://github.com/');
  cleaned = cleaned.replace(/^git@github\.com:/, 'https://github.com/');
  cleaned = cleaned.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  cleaned = cleaned.replace(/^git:\/\/github\.com\//, 'https://github.com/');
  cleaned = cleaned.replace(/\.git$/, '');
  if (!cleaned.startsWith('http')) cleaned = `https://${cleaned}`;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

/**
 * Some registries return repo info as an array (hex's `meta.links`) or a map
 * (pypi's `project_urls`). Probe the obvious shapes for a GitHub URL.
 */
function coerceToGithubUrl(raw: unknown): string | null {
  if (typeof raw === 'string') return normaliseGithubUrl(raw);

  // Array-of-strings (hex.pm's meta.links is actually an object, but
  // some registries return arrays of {label, url}).
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') {
        const norm = normaliseGithubUrl(entry);
        if (norm) return norm;
      } else if (entry && typeof entry === 'object') {
        const candidate =
          (entry as Record<string, unknown>).url ?? (entry as Record<string, unknown>).href;
        if (typeof candidate === 'string') {
          const norm = normaliseGithubUrl(candidate);
          if (norm) return norm;
        }
      }
    }
    return null;
  }

  // Dict-like: pypi `project_urls`, hex `meta.links`. Prefer the entry whose
  // key hints at source code.
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const sourceHints = [
      'Source',
      'source',
      'Repository',
      'repository',
      'GitHub',
      'github',
      'Code',
      'code',
    ];
    for (const key of sourceHints) {
      const v = obj[key];
      if (typeof v === 'string') {
        const norm = normaliseGithubUrl(v);
        if (norm) return norm;
      }
    }
    // Fallback: first value that looks like a github URL.
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.includes('github.com')) {
        const norm = normaliseGithubUrl(v);
        if (norm) return norm;
      }
    }
  }

  return null;
}

export interface CanonicalLookupResult {
  github_url: string;
  /** Which registry we pulled this from (same key as `REGISTRY_CONFIGS`). */
  registry: string;
}

/**
 * Resolve the canonical GitHub URL for a package name from its registry.
 *
 * Returns null when:
 *  - `ecosystem` isn't in `REGISTRY_CONFIGS`,
 *  - the registry has no `repoUrlField` defined (e.g. swift-pm, some maven
 *    mirrors) — we can't parse the response deterministically,
 *  - the registry metadata fetch fails (network error, 404, etc. — already
 *    logged at debug by `fetchRegistryMetadata`),
 *  - the extracted value doesn't normalise to a github.com URL.
 */
export async function resolveCanonicalGithubUrl(
  ecosystem: string,
  packageName: string,
): Promise<CanonicalLookupResult | null> {
  const config = REGISTRY_CONFIGS[ecosystem];
  if (!config) {
    logger.debug({ ecosystem, packageName }, 'No REGISTRY_CONFIGS entry — skipping lookup');
    return null;
  }
  if (!config.metadataUrl || !config.repoUrlField) {
    logger.debug(
      { ecosystem, packageName },
      'Registry has no metadataUrl / repoUrlField — cannot resolve canonical URL',
    );
    return null;
  }

  const metadata = await fetchRegistryMetadata(ecosystem, packageName);
  if (!metadata) return null;

  const raw = getNestedField(metadata, config.repoUrlField);
  const github_url = coerceToGithubUrl(raw);
  if (!github_url) {
    logger.debug(
      { ecosystem, packageName, raw: typeof raw },
      'Registry metadata returned no parseable GitHub URL',
    );
    return null;
  }

  return { github_url, registry: ecosystem };
}

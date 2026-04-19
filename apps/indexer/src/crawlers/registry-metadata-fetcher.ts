import { createLogger } from '@toolcairn/errors';
import { REGISTRY_CONFIGS } from './registry-config.js';

const logger = createLogger({ name: '@toolcairn/indexer:registry-metadata-fetcher' });

/**
 * Fetch raw JSON metadata for a package from its registry.
 *
 * Used by the GitHub crawler path to collect version data for detected
 * `package_managers` channels — without it, only tools indexed via direct
 * registry prefix (`npm:foo`, `pypi:bar`, `cargo:baz`) get version metadata.
 *
 * Non-fatal: returns null on HTTP failure, timeout, JSON-parse error, or
 * when the registry has no metadataUrl. Never throws.
 */
export async function fetchRegistryMetadata(
  registry: string,
  packageName: string,
): Promise<unknown | null> {
  const config = REGISTRY_CONFIGS[registry];
  if (!config?.metadataUrl) return null;

  // Some registries need URL escaping (npm scoped packages, packagist vendor/pkg, etc.).
  // We escape the path component but preserve `/` for vendor-prefixed names.
  const safeName = packageName
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const url = config.metadataUrl.replace('{pkg}', safeName);

  try {
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.debug(
        { url, status: res.status, registry },
        'registry metadata fetch returned non-200',
      );
      return null;
    }
    return await res.json();
  } catch (e) {
    logger.debug({ err: e, url, registry }, 'registry metadata fetch failed (non-fatal)');
    return null;
  }
}

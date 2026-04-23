export {
  REGISTRY_CONFIGS,
  INSTALL_PATTERNS,
  TOPIC_REGISTRY_HINTS,
  type RegistryConfig,
  type TimeWindow,
  type VersionExtractor,
  type RegistryRangeSystem,
  type DepsDevSystem,
  type InstallPattern,
} from './registry-config.js';
export { fetchRegistryMetadata } from './metadata-fetcher.js';
export { resolveCanonicalGithubUrl, type CanonicalLookupResult } from './canonical-url.js';

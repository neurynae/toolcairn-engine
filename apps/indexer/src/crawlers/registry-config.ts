/**
 * Thin re-export shim. The authoritative registry config now lives in
 * `@toolcairn/registry` so both the indexer and the API-side
 * `suggest_graph_update` handler share one source of truth. Existing indexer
 * imports keep working unchanged through this re-export.
 */
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
} from '@toolcairn/registry';

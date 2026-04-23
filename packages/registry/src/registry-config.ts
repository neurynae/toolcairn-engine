/**
 * Complete registry configuration for all package managers.
 *
 * Used by:
 * 1. README install command parser — to detect distribution channels
 * 2. Download fetcher — to query registry APIs for download counts
 * 3. Credibility calculator — to determine if downloads are applicable
 *
 * Detection is README-first (not file-based). We parse install commands from
 * README to discover which registries a tool is distributed on, then probe
 * those registries for download counts.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type TimeWindow = 'weekly' | 'monthly' | '90d' | 'alltime';

/**
 * Which extractor handles version metadata for this registry.
 * - Tier A (registry-specific): parses rich dep data from the existing metadataUrl payload.
 * - deps_dev: calls deps.dev API for the 7 ecosystems it covers.
 * - version_only: stores just `{version, release_date}` — no edges.
 * - none: skip version extraction entirely.
 */
export type VersionExtractor =
  | 'npm'
  | 'pypi'
  | 'crates'
  | 'rubygems'
  | 'packagist'
  | 'pub'
  | 'hex'
  | 'deps_dev'
  | 'version_only'
  | 'none';

/** Range constraint syntax used for edges sourced from this registry. */
export type RegistryRangeSystem =
  | 'semver'
  | 'pep440'
  | 'maven'
  | 'composer'
  | 'ruby'
  | 'cargo'
  | 'opaque';

/** deps.dev system name (as used in https://api.deps.dev/v3/systems/{sys}/...). */
export type DepsDevSystem = 'NPM' | 'PYPI' | 'CARGO' | 'MAVEN' | 'GO' | 'NUGET' | 'PACKAGIST';

export interface RegistryConfig {
  /** Human-readable name */
  name: string;
  /** Base URL for metadata (used for ownership verification) */
  metadataUrl?: string;
  /** Download stats API URL pattern. {pkg} is replaced with package name */
  downloadApiUrl?: string;
  /** Path in JSON response to extract download count */
  downloadField: string;
  /** Time window of the returned download count */
  timeWindow: TimeWindow;
  /** Path in metadata JSON to find the repository/homepage URL (for ownership verification) */
  repoUrlField?: string;
  /** Required HTTP headers for the API */
  headers?: Record<string, string>;
  /** Whether this registry has a usable public download API */
  hasDownloadApi: boolean;
  /**
   * Weekly download count for a "very popular" tool in this ecosystem.
   * Used for log-normalization (credibility dlScore) and as fallback quality gate
   * threshold (logScale/100) before the weekly percentile cron provides real values.
   */
  logScale?: number;
  /** Which version extractor handles this registry. Default: 'version_only'. */
  versionExtractor?: VersionExtractor;
  /** Default range system for edges from this registry. */
  rangeSystem?: RegistryRangeSystem;
  /** deps.dev system identifier (only for Tier B registries). */
  depsDevSystem?: DepsDevSystem;
}

export interface InstallPattern {
  /** Registry this command installs from */
  registry: string;
  /** Regex pattern to match the install command and capture package name.
   *  Must have a named capture group `pkg` for the package name. */
  pattern: RegExp;
}

// ─── Registry Configs ───────────────────────────────────────────────────────

export const REGISTRY_CONFIGS: Record<string, RegistryConfig> = {
  npm: {
    name: 'npm',
    metadataUrl: 'https://registry.npmjs.org/{pkg}',
    downloadApiUrl: 'https://api.npmjs.org/downloads/point/last-week/{pkg}',
    downloadField: 'downloads',
    timeWindow: 'weekly',
    repoUrlField: 'repository.url',
    hasDownloadApi: true,
    logScale: 1_000_000,
    versionExtractor: 'npm',
    rangeSystem: 'semver',
    depsDevSystem: 'NPM',
  },
  pypi: {
    name: 'PyPI',
    metadataUrl: 'https://pypi.org/pypi/{pkg}/json',
    downloadApiUrl: 'https://pypistats.org/api/packages/{pkg}/recent',
    downloadField: 'data.last_week',
    timeWindow: 'weekly',
    repoUrlField: 'info.project_urls',
    hasDownloadApi: true,
    logScale: 1_000_000,
    versionExtractor: 'pypi',
    rangeSystem: 'pep440',
    depsDevSystem: 'PYPI',
  },
  crates: {
    name: 'crates.io',
    metadataUrl: 'https://crates.io/api/v1/crates/{pkg}',
    downloadApiUrl: 'https://crates.io/api/v1/crates/{pkg}',
    downloadField: 'crate.recent_downloads',
    timeWindow: '90d',
    repoUrlField: 'crate.repository',
    headers: { 'User-Agent': 'toolcairn-indexer (https://github.com/neurynae/toolcairn-engine)' },
    hasDownloadApi: true,
    logScale: 100_000,
    versionExtractor: 'crates',
    rangeSystem: 'cargo',
    depsDevSystem: 'CARGO',
  },
  rubygems: {
    name: 'RubyGems',
    metadataUrl: 'https://rubygems.org/api/v1/gems/{pkg}.json',
    downloadApiUrl: 'https://rubygems.org/api/v1/gems/{pkg}.json',
    downloadField: 'downloads',
    timeWindow: 'alltime',
    repoUrlField: 'source_code_uri',
    hasDownloadApi: true,
    logScale: 50_000,
    versionExtractor: 'rubygems',
    rangeSystem: 'ruby',
  },
  packagist: {
    name: 'Packagist',
    metadataUrl: 'https://packagist.org/packages/{pkg}.json',
    downloadApiUrl: 'https://packagist.org/packages/{pkg}/stats.json',
    downloadField: 'downloads.monthly',
    timeWindow: 'monthly',
    repoUrlField: 'package.repository',
    headers: { 'User-Agent': 'toolcairn-indexer (mailto:admin@neurynae.com)' },
    hasDownloadApi: true,
    logScale: 200_000,
    versionExtractor: 'packagist',
    rangeSystem: 'composer',
    depsDevSystem: 'PACKAGIST',
  },
  nuget: {
    name: 'NuGet',
    downloadApiUrl:
      'https://azuresearch-usnc.nuget.org/query?q=packageid:{pkg}&take=1&prerelease=false&semVerLevel=2.0.0',
    downloadField: 'data.0.totalDownloads',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 500_000,
    versionExtractor: 'deps_dev',
    rangeSystem: 'semver',
    depsDevSystem: 'NUGET',
  },
  pub: {
    name: 'pub.dev',
    metadataUrl: 'https://pub.dev/api/packages/{pkg}',
    downloadApiUrl: 'https://pub.dev/api/packages/{pkg}/score',
    downloadField: 'downloadCount30Days',
    timeWindow: 'monthly',
    hasDownloadApi: true,
    logScale: 50_000,
    versionExtractor: 'pub',
    rangeSystem: 'semver',
  },
  hex: {
    name: 'Hex.pm',
    metadataUrl: 'https://hex.pm/api/packages/{pkg}',
    downloadApiUrl: 'https://hex.pm/api/packages/{pkg}',
    downloadField: 'downloads.week',
    timeWindow: 'weekly',
    repoUrlField: 'meta.links',
    headers: { 'User-Agent': 'toolcairn-indexer' },
    hasDownloadApi: true,
    logScale: 10_000,
    versionExtractor: 'hex',
    rangeSystem: 'semver',
  },
  cran: {
    name: 'CRAN',
    downloadApiUrl: 'https://cranlogs.r-pkg.org/downloads/total/last-week/{pkg}',
    downloadField: 'downloads',
    timeWindow: 'weekly',
    hasDownloadApi: true,
    logScale: 50_000,
  },
  clojars: {
    name: 'Clojars',
    downloadApiUrl: 'https://clojars.org/api/artifacts/{pkg}',
    downloadField: 'downloads',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 50_000,
  },
  dub: {
    name: 'DUB',
    downloadApiUrl: 'https://code.dlang.org/api/packages/{pkg}/stats',
    downloadField: 'downloads.weekly',
    timeWindow: 'weekly',
    hasDownloadApi: true,
    logScale: 5_000,
  },
  docker: {
    name: 'Docker Hub',
    downloadApiUrl: 'https://hub.docker.com/v2/repositories/{pkg}/',
    downloadField: 'pull_count',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 100_000,
  },
  homebrew: {
    name: 'Homebrew',
    downloadApiUrl: 'https://formulae.brew.sh/api/formula/{pkg}.json',
    downloadField: 'analytics.install.30d',
    timeWindow: 'monthly',
    hasDownloadApi: true,
    logScale: 10_000,
  },
  terraform: {
    name: 'Terraform Registry',
    downloadApiUrl: 'https://registry.terraform.io/v2/modules/{pkg}/downloads/summary',
    downloadField: 'data.attributes.week',
    timeWindow: 'weekly',
    hasDownloadApi: true,
    logScale: 5_000,
  },
  ansible: {
    name: 'Ansible Galaxy',
    downloadApiUrl:
      'https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/index/{pkg}/',
    downloadField: 'download_count',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 50_000,
  },
  puppet: {
    name: 'Puppet Forge',
    downloadApiUrl: 'https://forgeapi.puppet.com/v3/modules/{pkg}',
    downloadField: 'downloads',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 10_000,
  },
  chef: {
    name: 'Chef Supermarket',
    downloadApiUrl: 'https://supermarket.chef.io/api/v1/cookbooks/{pkg}',
    downloadField: 'metrics.downloads.total',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 10_000,
  },
  flathub: {
    name: 'Flathub',
    downloadApiUrl: 'https://flathub.org/api/v2/stats/{pkg}',
    downloadField: 'installs_last_7_days',
    timeWindow: 'weekly',
    hasDownloadApi: true,
    logScale: 5_000,
  },
  wordpress: {
    name: 'WordPress.org',
    downloadApiUrl:
      'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]={pkg}',
    downloadField: 'downloaded',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 50_000,
  },
  vscode: {
    name: 'VS Code Marketplace',
    // Special: uses POST, handled separately in download-fetcher.ts
    downloadField: 'statistics.install',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 100_000,
  },
  julia: {
    name: 'Julia Packages',
    downloadApiUrl: 'https://juliapkgstats.com/api/v2/monthly_downloads/{pkg}',
    downloadField: 'total_requests',
    timeWindow: 'monthly',
    hasDownloadApi: true,
    logScale: 10_000,
  },
  cocoapods: {
    name: 'CocoaPods',
    downloadApiUrl: 'https://metrics.cocoapods.org/api/v1/pods/{pkg}',
    downloadField: 'stats.download_week',
    timeWindow: 'weekly',
    hasDownloadApi: true,
    logScale: 10_000,
  },

  // ── Registries WITHOUT download APIs ──────────────────────────────────────
  go: {
    name: 'Go Modules',
    downloadField: '',
    timeWindow: 'weekly',
    hasDownloadApi: false,
    versionExtractor: 'deps_dev',
    rangeSystem: 'semver',
    depsDevSystem: 'GO',
  },
  maven: {
    name: 'Maven Central',
    downloadField: '',
    timeWindow: 'weekly',
    hasDownloadApi: false,
    versionExtractor: 'deps_dev',
    rangeSystem: 'maven',
    depsDevSystem: 'MAVEN',
  },
  gradle: {
    name: 'Gradle Plugin Portal',
    downloadField: '',
    timeWindow: 'weekly',
    hasDownloadApi: false,
    versionExtractor: 'deps_dev',
    rangeSystem: 'maven',
    depsDevSystem: 'MAVEN',
  },
  hackage: { name: 'Hackage', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  cpan: { name: 'CPAN', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  luarocks: { name: 'LuaRocks', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  nimble: { name: 'Nimble', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  opam: { name: 'opam', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  vcpkg: { name: 'vcpkg', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  conan: { name: 'Conan', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  spm: {
    name: 'Swift Package Manager',
    downloadField: '',
    timeWindow: 'weekly',
    hasDownloadApi: false,
  },
  elm: { name: 'Elm Packages', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  nix: { name: 'Nix', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
};

// ─── README Install Command Patterns ────────────────────────────────────────
// Each pattern has a named capture group `pkg` for the package name.
// Patterns are matched inside markdown code blocks only.
//
// Two guardrails apply universally:
//
//   1. FLAGS consumer — eats any -short / --long / --flag=value tokens
//      that appear between the command and the package name. Prevents the
//      previous "first install command wins" behaviour from capturing a
//      flag (e.g. `--save`) as the package name.
//
//   2. Package name MUST start with a non-`-` character. The capture uses
//      `[A-Za-z0-9_]` as its first char (after an optional `@` for scoped
//      npm packages). Registry specifications across all 35+ ecosystems
//      forbid leading dashes — this makes the regex match reality.
//
// Together they killed the ~30 cases observed in the v0.10.x backfill where
// CLI flags like `--save`, `--save-dev`, `--unsafe-perm`, `--locked`,
// `--upgrade`, `-r`, `-it`, etc. were ending up in `Tool.package_managers`.

/**
 * Universal flag-consumer prefix. Sits between the command and the package
 * name capture. Matches zero or more flags of the form:
 *   -x            short flag (-g, -D, -v, -it)
 *   --long-flag   long flag (--save, --save-dev, --unsafe-perm)
 *   --flag=value  long flag with value (--registry=https://...)
 *   -x=value      short flag with value
 * Each followed by whitespace. Written as a string to share across patterns.
 */
const FLAGS = String.raw`(?:(?:-\w+|--[\w-]+)(?:=\S+)?\s+)*`;

/** Build a regex from parts, hiding the `new RegExp(..., 'i')` boilerplate. */
function mk(...parts: string[]): RegExp {
  return new RegExp(parts.join(''), 'i');
}
/** Same as mk() but with the multiline-insensitive flag (for go/docker EOL anchoring). */
function mkM(...parts: string[]): RegExp {
  return new RegExp(parts.join(''), 'im');
}

export const INSTALL_PATTERNS: InstallPattern[] = [
  // ── JavaScript/TypeScript (all use npm registry) ──
  {
    registry: 'npm',
    pattern: mk(
      String.raw`npm\s+(?:install|i|add)\s+`,
      FLAGS,
      String.raw`(?<pkg>@?[A-Za-z0-9_][\w./-]*)`,
    ),
  },
  {
    registry: 'npm',
    pattern: mk(String.raw`yarn\s+add\s+`, FLAGS, String.raw`(?<pkg>@?[A-Za-z0-9_][\w./-]*)`),
  },
  {
    registry: 'npm',
    pattern: mk(
      String.raw`pnpm\s+(?:add|install|i)\s+`,
      FLAGS,
      String.raw`(?<pkg>@?[A-Za-z0-9_][\w./-]*)`,
    ),
  },
  {
    registry: 'npm',
    pattern: mk(
      String.raw`bun\s+(?:add|install|i)\s+`,
      FLAGS,
      String.raw`(?<pkg>@?[A-Za-z0-9_][\w./-]*)`,
    ),
  },
  {
    registry: 'npm',
    pattern: mk(String.raw`npx\s+`, FLAGS, String.raw`(?<pkg>@?[A-Za-z0-9_][\w./-]*)`),
  },

  // ── Python (all use PyPI) ──
  {
    registry: 'pypi',
    pattern: mk(String.raw`pip3?\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`),
  },
  {
    registry: 'pypi',
    pattern: mk(String.raw`poetry\s+add\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`),
  },
  {
    registry: 'pypi',
    pattern: mk(
      String.raw`uv\s+(?:add|pip\s+install)\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`,
    ),
  },
  {
    registry: 'pypi',
    pattern: mk(String.raw`pipenv\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`),
  },
  {
    registry: 'pypi',
    pattern: mk(String.raw`pdm\s+add\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`),
  },
  {
    registry: 'pypi',
    pattern: mk(String.raw`conda\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`),
  },

  // ── Rust ──
  {
    registry: 'crates',
    pattern: mk(
      String.raw`cargo\s+(?:add|install)\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`,
    ),
  },

  // ── Ruby ──
  {
    registry: 'rubygems',
    pattern: mk(String.raw`gem\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },
  {
    registry: 'rubygems',
    pattern: mk(String.raw`bundle\s+add\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },

  // ── PHP ──
  {
    registry: 'packagist',
    pattern: mk(
      String.raw`composer\s+require\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w-]*\/[A-Za-z0-9_][\w-]*)`,
    ),
  },

  // ── .NET ──
  {
    registry: 'nuget',
    pattern: mk(
      String.raw`dotnet\s+add\s+package\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w.]*)`,
    ),
  },
  {
    registry: 'nuget',
    pattern: mk(String.raw`Install-Package\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w.]*)`),
  },

  // ── Dart/Flutter ──
  {
    registry: 'pub',
    pattern: mk(
      String.raw`(?:dart|flutter)\s+pub\s+add\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_]\w*)`,
    ),
  },

  // ── Go ──
  // Go module paths are github.com/foo/bar-style. No FLAGS consumer — `go install`
  // doesn't take flags that precede the module path in typical docs usage.
  {
    registry: 'go',
    pattern: mkM(String.raw`go\s+(?:install|get)\s+(?<pkg>[A-Za-z0-9_][\w./-]*?)(?:@\S+)?$`),
  },

  // ── Elixir/Erlang ──
  // `{:pkg, "~> ..."}` mix.exs syntax — no flags possible.
  { registry: 'hex', pattern: /\{:(?<pkg>\w+),\s*"~>/i },

  // ── R ──
  // `install.packages("pkg")` — no flags possible.
  { registry: 'cran', pattern: /install\.packages\s*\(\s*["'](?<pkg>[A-Za-z0-9_][\w.]*)["']/i },

  // ── Docker ──
  // docker pull/run images — first char can't be `-`.
  {
    registry: 'docker',
    pattern: mkM(
      String.raw`docker\s+(?:pull|run)\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w./-]*?)(?::\S+)?$`,
    ),
  },

  // ── Homebrew ──
  {
    registry: 'homebrew',
    pattern: mk(String.raw`brew\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w@.-]*)`),
  },

  // ── Terraform ──
  // `source = "namespace/name/provider"` — first char can't be `-`.
  {
    registry: 'terraform',
    pattern: /source\s*=\s*"(?<pkg>[A-Za-z0-9_][\w-]*\/[A-Za-z0-9_][\w-]*\/[A-Za-z0-9_][\w-]*)"/i,
  },

  // ── Ansible ──
  {
    registry: 'ansible',
    pattern: mk(
      String.raw`ansible-galaxy\s+(?:collection|role)\s+install\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`,
    ),
  },

  // ── Helm ──
  // `helm install <release> <chart>` — release-name is `\S+`, chart starts with non-dash.
  {
    registry: 'helm',
    pattern: mk(
      String.raw`helm\s+(?:install|repo\s+add)\s+\S+\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w./-]*)`,
    ),
  },

  // ── Haskell ──
  {
    registry: 'hackage',
    pattern: mk(
      String.raw`(?:cabal|stack)\s+install\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`,
    ),
  },

  // ── Perl ──
  // Perl modules use :: separators (e.g. Net::SSH).
  {
    registry: 'cpan',
    pattern: mk(String.raw`cpanm?\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w:]*)`),
  },

  // ── Lua ──
  {
    registry: 'luarocks',
    pattern: mk(String.raw`luarocks\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },

  // ── D ──
  {
    registry: 'dub',
    pattern: mk(String.raw`dub\s+add\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },

  // ── Nim ──
  {
    registry: 'nimble',
    pattern: mk(String.raw`nimble\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },

  // ── OCaml ──
  {
    registry: 'opam',
    pattern: mk(String.raw`opam\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },

  // ── Clojure ──
  // `[group/artifact "version"]` — Leiningen dep coord. No flags apply.
  {
    registry: 'clojars',
    pattern: /\[(?<pkg>[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*)\s+"[\d.]+"\]/i,
  },

  // ── Julia ──
  { registry: 'julia', pattern: /Pkg\.add\s*\(\s*"(?<pkg>[A-Za-z0-9_]\w*)"\s*\)/i },

  // ── WordPress ──
  { registry: 'wordpress', pattern: /wordpress\.org\/plugins\/(?<pkg>[A-Za-z0-9_][\w-]*)/i },

  // ── VS Code ──
  {
    registry: 'vscode',
    pattern:
      /(?:ext\s+install|marketplace\.visualstudio\.com\/items\?itemName=)(?<pkg>[A-Za-z0-9_][\w.-]*)/i,
  },

  // ── Flatpak ──
  {
    registry: 'flathub',
    pattern: mk(
      String.raw`flatpak\s+install\s+(?:flathub\s+)?`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`,
    ),
  },

  // ── System packages ──
  {
    registry: 'apt',
    pattern: mk(
      String.raw`(?:apt|apt-get)\s+install\s+`,
      FLAGS,
      String.raw`(?<pkg>[A-Za-z0-9_][\w.-]*)`,
    ),
  },
  {
    registry: 'snap',
    pattern: mk(String.raw`snap\s+install\s+`, FLAGS, String.raw`(?<pkg>[A-Za-z0-9_][\w-]*)`),
  },
];

// ─── Topic-to-Registry Mapping ──────────────────────────────────────────────
// GitHub topics that hint at a specific registry.

export const TOPIC_REGISTRY_HINTS: Record<string, string> = {
  'npm-package': 'npm',
  'npm-module': 'npm',
  npm: 'npm',
  pypi: 'pypi',
  'python-library': 'pypi',
  pip: 'pypi',
  crate: 'crates',
  'crates-io': 'crates',
  rubygem: 'rubygems',
  gem: 'rubygems',
  composer: 'packagist',
  packagist: 'packagist',
  nuget: 'nuget',
  dotnet: 'nuget',
  'pub-dev': 'pub',
  'flutter-package': 'pub',
  'dart-package': 'pub',
  'hex-pm': 'hex',
  'elixir-library': 'hex',
  cran: 'cran',
  'r-package': 'cran',
  'docker-image': 'docker',
  dockerfile: 'docker',
  'homebrew-formula': 'homebrew',
  homebrew: 'homebrew',
  'terraform-module': 'terraform',
  'terraform-provider': 'terraform',
  'ansible-role': 'ansible',
  'ansible-collection': 'ansible',
  'helm-chart': 'helm',
  helm: 'helm',
  'wordpress-plugin': 'wordpress',
  'wordpress-theme': 'wordpress',
  'vscode-extension': 'vscode',
  vscode: 'vscode',
  flatpak: 'flathub',
  snap: 'snap',
  'go-module': 'go',
  'golang-library': 'go',
  'julia-package': 'julia',
  cocoapods: 'cocoapods',
  'puppet-module': 'puppet',
  'chef-cookbook': 'chef',
  clojure: 'clojars',
  'nim-package': 'nimble',
  opam: 'opam',
  'dub-package': 'dub',
  'd-language': 'dub',
};

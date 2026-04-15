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
  },
  nuget: {
    name: 'NuGet',
    downloadApiUrl:
      'https://azuresearch-usnc.nuget.org/query?q=packageid:{pkg}&take=1&prerelease=false&semVerLevel=2.0.0',
    downloadField: 'data.0.totalDownloads',
    timeWindow: 'alltime',
    hasDownloadApi: true,
    logScale: 500_000,
  },
  pub: {
    name: 'pub.dev',
    metadataUrl: 'https://pub.dev/api/packages/{pkg}',
    downloadApiUrl: 'https://pub.dev/api/packages/{pkg}/score',
    downloadField: 'downloadCount30Days',
    timeWindow: 'monthly',
    hasDownloadApi: true,
    logScale: 50_000,
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
  go: { name: 'Go Modules', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  maven: { name: 'Maven Central', downloadField: '', timeWindow: 'weekly', hasDownloadApi: false },
  gradle: {
    name: 'Gradle Plugin Portal',
    downloadField: '',
    timeWindow: 'weekly',
    hasDownloadApi: false,
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

export const INSTALL_PATTERNS: InstallPattern[] = [
  // ── JavaScript/TypeScript (all use npm registry) ──
  { registry: 'npm', pattern: /npm\s+(?:install|i|add)\s+(?:-[gDSEOB]\s+)*(?<pkg>@?[\w./-]+)/i },
  { registry: 'npm', pattern: /yarn\s+add\s+(?:--dev\s+)?(?<pkg>@?[\w./-]+)/i },
  { registry: 'npm', pattern: /pnpm\s+(?:add|install|i)\s+(?:--save-dev\s+)?(?<pkg>@?[\w./-]+)/i },
  { registry: 'npm', pattern: /bun\s+(?:add|install|i)\s+(?:--dev\s+)?(?<pkg>@?[\w./-]+)/i },
  { registry: 'npm', pattern: /npx\s+(?<pkg>@?[\w./-]+)/i },

  // ── Python (all use PyPI) ──
  { registry: 'pypi', pattern: /pip3?\s+install\s+(?:-U\s+)?(?<pkg>[\w.-]+)/i },
  { registry: 'pypi', pattern: /poetry\s+add\s+(?<pkg>[\w.-]+)/i },
  { registry: 'pypi', pattern: /uv\s+(?:add|pip\s+install)\s+(?<pkg>[\w.-]+)/i },
  { registry: 'pypi', pattern: /pipenv\s+install\s+(?<pkg>[\w.-]+)/i },
  { registry: 'pypi', pattern: /pdm\s+add\s+(?<pkg>[\w.-]+)/i },
  { registry: 'pypi', pattern: /conda\s+install\s+(?:-c\s+\S+\s+)?(?<pkg>[\w.-]+)/i },

  // ── Rust ──
  { registry: 'crates', pattern: /cargo\s+(?:add|install)\s+(?<pkg>[\w-]+)/i },

  // ── Ruby ──
  { registry: 'rubygems', pattern: /gem\s+install\s+(?<pkg>[\w-]+)/i },
  { registry: 'rubygems', pattern: /bundle\s+add\s+(?<pkg>[\w-]+)/i },

  // ── PHP ──
  { registry: 'packagist', pattern: /composer\s+require\s+(?<pkg>[\w-]+\/[\w-]+)/i },

  // ── .NET ──
  { registry: 'nuget', pattern: /dotnet\s+add\s+package\s+(?<pkg>[\w.]+)/i },
  { registry: 'nuget', pattern: /Install-Package\s+(?<pkg>[\w.]+)/i },

  // ── Dart/Flutter ──
  { registry: 'pub', pattern: /(?:dart|flutter)\s+pub\s+add\s+(?<pkg>[\w_]+)/i },

  // ── Go ──
  { registry: 'go', pattern: /go\s+(?:install|get)\s+(?<pkg>[\w./-]+?)(?:@\S+)?$/im },

  // ── Elixir/Erlang ──
  { registry: 'hex', pattern: /\{:(?<pkg>\w+),\s*"~>/i },

  // ── R ──
  { registry: 'cran', pattern: /install\.packages\s*\(\s*["'](?<pkg>[\w.]+)["']/i },

  // ── Docker ──
  { registry: 'docker', pattern: /docker\s+(?:pull|run)\s+(?<pkg>[\w./-]+?)(?::\S+)?$/im },

  // ── Homebrew ──
  { registry: 'homebrew', pattern: /brew\s+install\s+(?:--cask\s+)?(?<pkg>[\w@.-]+)/i },

  // ── Terraform ──
  { registry: 'terraform', pattern: /source\s*=\s*"(?<pkg>[\w-]+\/[\w-]+\/[\w-]+)"/i },

  // ── Ansible ──
  {
    registry: 'ansible',
    pattern: /ansible-galaxy\s+(?:collection|role)\s+install\s+(?<pkg>[\w.-]+)/i,
  },

  // ── Helm ──
  { registry: 'helm', pattern: /helm\s+(?:install|repo\s+add)\s+\S+\s+(?<pkg>[\w./-]+)/i },

  // ── Haskell ──
  { registry: 'hackage', pattern: /(?:cabal|stack)\s+install\s+(?<pkg>[\w-]+)/i },

  // ── Perl ──
  { registry: 'cpan', pattern: /cpanm?\s+(?<pkg>[\w:]+)/i },

  // ── Lua ──
  { registry: 'luarocks', pattern: /luarocks\s+install\s+(?<pkg>[\w-]+)/i },

  // ── D ──
  { registry: 'dub', pattern: /dub\s+add\s+(?<pkg>[\w-]+)/i },

  // ── Nim ──
  { registry: 'nimble', pattern: /nimble\s+install\s+(?<pkg>[\w-]+)/i },

  // ── OCaml ──
  { registry: 'opam', pattern: /opam\s+install\s+(?<pkg>[\w-]+)/i },

  // ── Clojure ──
  { registry: 'clojars', pattern: /\[(?<pkg>[\w.-]+\/[\w.-]+)\s+"[\d.]+"\]/i },

  // ── Julia ──
  { registry: 'julia', pattern: /Pkg\.add\s*\(\s*"(?<pkg>[\w]+)"\s*\)/i },

  // ── WordPress ──
  { registry: 'wordpress', pattern: /wordpress\.org\/plugins\/(?<pkg>[\w-]+)/i },

  // ── VS Code ──
  {
    registry: 'vscode',
    pattern: /(?:ext\s+install|marketplace\.visualstudio\.com\/items\?itemName=)(?<pkg>[\w.-]+)/i,
  },

  // ── Flatpak ──
  { registry: 'flathub', pattern: /flatpak\s+install\s+(?:flathub\s+)?(?<pkg>[\w.-]+)/i },

  // ── System packages ──
  { registry: 'apt', pattern: /(?:apt|apt-get)\s+install\s+(?:-y\s+)?(?<pkg>[\w.-]+)/i },
  { registry: 'snap', pattern: /snap\s+install\s+(?<pkg>[\w-]+)/i },
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

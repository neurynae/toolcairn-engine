/**
 * Parse README markdown for install commands to discover distribution channels.
 *
 * Detection approach (agreed design):
 * 1. Extract code blocks from README markdown
 * 2. Match install command patterns for ALL known registries
 * 3. Filter: keep only commands where package name fuzzy-matches the repo name
 *    (eliminates prerequisites like "pip install setuptools" in a Flask repo)
 * 4. Deduplicate by registry (npm install X and yarn add X = same npm registry)
 *
 * Fallback: if no fuzzy match found, take the first install command under an
 * "Installation" heading — it's almost always the tool itself.
 */

import { createLogger } from '@toolcairn/errors';
import { INSTALL_PATTERNS, TOPIC_REGISTRY_HINTS } from './registry-config.js';

const logger = createLogger({ name: '@toolcairn/indexer:readme-install-parser' });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredPackage {
  registry: string;
  packageName: string;
  rawCommand: string;
}

// ─── Code Block Extraction ──────────────────────────────────────────────────

/**
 * Extract text content from markdown code blocks (fenced and indented).
 * Install commands are almost always inside code blocks.
 */
function extractCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];

  // Fenced code blocks: ```...``` or ~~~...~~~
  const fencedRegex = /(?:^|\n)(?:`{3,}|~{3,})(?:\w*\n)([\s\S]*?)(?:`{3,}|~{3,})/g;
  let match: RegExpExecArray | null = fencedRegex.exec(markdown);
  while (match !== null) {
    if (match[1]) blocks.push(match[1]);
    match = fencedRegex.exec(markdown);
  }

  // Indented code blocks (4 spaces or 1 tab)
  const lines = markdown.split('\n');
  let indentedBlock = '';
  for (const line of lines) {
    if (/^(?: {4}|\t)/.test(line)) {
      indentedBlock += `${line.trim()}\n`;
    } else if (indentedBlock) {
      blocks.push(indentedBlock.trim());
      indentedBlock = '';
    }
  }
  if (indentedBlock) blocks.push(indentedBlock.trim());

  // Also check inline code: `npm install X` (single backtick)
  const inlineRegex = /`([^`]+)`/g;
  match = inlineRegex.exec(markdown);
  while (match !== null) {
    if (match[1]) blocks.push(match[1]);
    match = inlineRegex.exec(markdown);
  }

  return blocks;
}

// ─── Install Command Parsing ────────────────────────────────────────────────

/**
 * Parse ALL install commands from README content.
 * Returns every {registry, packageName} found — unfiltered.
 */
export function parseInstallCommands(readme: string): DiscoveredPackage[] {
  const codeBlocks = extractCodeBlocks(readme);
  const found: DiscoveredPackage[] = [];
  const seen = new Set<string>(); // dedup: "registry:packageName"

  for (const block of codeBlocks) {
    // Split block into individual lines — each line could be a separate command
    const lines = block.split('\n');

    for (const line of lines) {
      const trimmed = line.replace(/^\$\s*/, '').trim(); // strip leading $ prompt
      if (!trimmed) continue;

      for (const { registry, pattern } of INSTALL_PATTERNS) {
        const match = pattern.exec(trimmed);
        if (!match?.groups?.pkg) continue;

        let pkg = match.groups.pkg;
        // Clean version specifiers:
        //   flask[async]  → flask
        //   express@latest → express
        //   @types/node@latest → @types/node   (don't eat the leading @scope)
        //   foo:1.0       → foo
        pkg = pkg.replace(/\[.*\]$/, '');
        if (pkg.startsWith('@')) {
          // Scoped npm: only strip @version if we find a SECOND @ in the string.
          // e.g. "@types/node@latest" → "@types/node"; "@types/node" stays.
          const secondAt = pkg.indexOf('@', 1);
          if (secondAt > 0) pkg = pkg.slice(0, secondAt);
        } else {
          pkg = pkg.replace(/@\S+$/, '');
        }
        pkg = pkg.replace(/:.*$/, '');
        // Clean trailing punctuation from markdown
        pkg = pkg.replace(/['"`,;)}\]]+$/, '');

        if (!pkg || pkg.length < 2) continue;

        const key = `${registry}:${pkg.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        found.push({ registry, packageName: pkg, rawCommand: trimmed });
      }
    }
  }

  return found;
}

// ─── Package Name Matching ──────────────────────────────────────────────────

/**
 * Normalize a name for comparison: lowercase, remove dots/hyphens/underscores.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '');
}

/**
 * Check if a package name fuzzy-matches the repo name or owner name.
 *
 * Matching rules:
 * - Exact: "express" == "express"
 * - Repo contains package: "next.js" contains "next"
 * - Package contains repo: "@nestjs/core" contains "nest"
 * - Owner match: "@angular/core" owner "angular" matches owner "angular"
 * - Normalized match: "socket.io" ↔ "socketio"
 */
function packageMatchesRepo(packageName: string, repoName: string, ownerName: string): boolean {
  const normPkg = normalize(packageName);
  const normRepo = normalize(repoName);
  const normOwner = normalize(ownerName);

  // Extract scope/namespace from package: @scope/name → scope, name
  const scopeMatch = packageName.match(/^@([\w.-]+)\/([\w.-]+)/);
  const pkgScope = scopeMatch?.[1] ? normalize(scopeMatch[1]) : '';
  const pkgBase = scopeMatch?.[2] ? normalize(scopeMatch[2]) : normPkg;

  // For composer: vendor/package → vendor, package
  const vendorMatch = packageName.match(/^([\w-]+)\/([\w-]+)$/);
  const vendorName = vendorMatch?.[1] ? normalize(vendorMatch[1]) : '';
  const vendorPkg = vendorMatch?.[2] ? normalize(vendorMatch[2]) : '';

  // Exact match
  if (normPkg === normRepo) return true;
  if (pkgBase === normRepo) return true;

  // Repo contains package (next.js contains next)
  if (normRepo.includes(pkgBase) && pkgBase.length >= 3) return true;

  // Package contains repo (nestjs-core contains nest → if repo is "nest")
  if (pkgBase.includes(normRepo) && normRepo.length >= 3) return true;

  // Owner/scope match: @angular/core → scope "angular" matches owner "angular"
  if (pkgScope && pkgScope === normOwner) return true;

  // Vendor match: laravel/framework → vendor "laravel" matches owner "laravel"
  if (vendorName && vendorName === normOwner) return true;
  if (vendorPkg && vendorPkg === normRepo) return true;

  // Docker namespace match: docker pull redis → "redis" matches repo "redis"
  // Docker pull org/image → "org" matches owner
  if (vendorName && vendorName === normOwner && vendorPkg === normRepo) return true;

  return false;
}

/**
 * Filter discovered packages: keep only the tool's OWN distribution channels.
 * Deduplicates by registry (npm install X and yarn add X = same registry).
 */
export function filterOwnPackages(
  commands: DiscoveredPackage[],
  repoName: string,
  ownerName: string,
): DiscoveredPackage[] {
  const matched: DiscoveredPackage[] = [];
  const seenRegistries = new Set<string>();

  for (const cmd of commands) {
    if (seenRegistries.has(cmd.registry)) continue;

    if (packageMatchesRepo(cmd.packageName, repoName, ownerName)) {
      matched.push(cmd);
      seenRegistries.add(cmd.registry);
    }
  }

  return matched;
}

// ─── Installation Heading Fallback ──────────────────────────────────────────

/**
 * If no fuzzy match was found by the primary path, look for install commands
 * under an "Installation" / "Getting Started" heading — but require each
 * candidate to fuzzy-match the repo/owner name before accepting it.
 *
 * Why the guard: the previous version returned the first install command in
 * the section regardless of target, which poisoned `package_managers` for
 * many tools (e.g. a README that documents `npm install zod` as a setup step
 * marked zod as the tool's own distribution channel). Post-discovery the
 * engine runs full registry-side ownership verification via
 * `verifyAndFetchAllChannels`, but this guard doubles as:
 *   1. A short-circuit that avoids a wasted HTTP call per obvious mismatch.
 *   2. The only defense for registries without a metadataUrl in
 *      registry-config.ts (hackage, cpan, luarocks, nimble, opam, vcpkg,
 *      conan, spm, elm, nix) — those are trusted as-discovered, so the
 *      fuzzy check is the last line of defense before they become
 *      `package_managers` entries.
 */
function findFirstInstallUnderHeading(
  readme: string,
  repoName: string,
  ownerName: string,
): DiscoveredPackage | null {
  const headingRegex =
    /^#{1,3}\s+(?:install(?:ation)?|getting\s+started|quick\s*start|setup|usage)\s*$/im;
  const headingMatch = headingRegex.exec(readme);
  if (!headingMatch) return null;

  // Get content after the heading until the next heading
  const afterHeading = readme.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = afterHeading.search(/^#{1,3}\s+/m);
  const section =
    nextHeading > 0 ? afterHeading.slice(0, nextHeading) : afterHeading.slice(0, 2000);

  const commands = parseInstallCommands(section);
  for (const cmd of commands) {
    if (packageMatchesRepo(cmd.packageName, repoName, ownerName)) return cmd;
  }
  return null;
}

// ─── Main Discovery Function ────────────────────────────────────────────────

/**
 * Discover all distribution channels for a tool from its README and topics.
 *
 * @param readme - Raw README markdown content
 * @param repoName - GitHub repo name (e.g. "express" from expressjs/express)
 * @param ownerName - GitHub owner name (e.g. "expressjs")
 * @param topics - GitHub topics array
 * @returns Array of confirmed {registry, packageName} pairs
 */
export function discoverDistributionChannels(
  readme: string | undefined,
  repoName: string,
  ownerName: string,
  topics: string[],
): DiscoveredPackage[] {
  const results: DiscoveredPackage[] = [];
  const seenRegistries = new Set<string>();

  // Signal 1: README install commands (primary)
  if (readme) {
    const allCommands = parseInstallCommands(readme);
    const ownPackages = filterOwnPackages(allCommands, repoName, ownerName);

    for (const pkg of ownPackages) {
      if (!seenRegistries.has(pkg.registry)) {
        results.push(pkg);
        seenRegistries.add(pkg.registry);
      }
    }

    // Fallback: if no match, look under the Installation heading — guarded by
    // the same fuzzy-match rule used by `filterOwnPackages` so we only accept
    // captures that plausibly belong to THIS tool.
    if (results.length === 0) {
      const fallback = findFirstInstallUnderHeading(readme, repoName, ownerName);
      if (fallback && !seenRegistries.has(fallback.registry)) {
        results.push(fallback);
        seenRegistries.add(fallback.registry);
      }
    }
  }

  // Signal 2: GitHub topics (secondary — only for registries not already found)
  for (const topic of topics) {
    const registry = TOPIC_REGISTRY_HINTS[topic];
    if (registry && !seenRegistries.has(registry)) {
      // Topic hints don't give us a package name — use repo name as candidate
      results.push({
        registry,
        packageName: repoName,
        rawCommand: `topic:${topic}`,
      });
      seenRegistries.add(registry);
    }
  }

  if (results.length > 0) {
    logger.debug(
      {
        repoName,
        channels: results.map((r) => `${r.registry}:${r.packageName}`),
      },
      'Distribution channels discovered',
    );
  }

  return results;
}

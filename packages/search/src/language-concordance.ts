/**
 * Language concordance scoring — penalizes tools from wrong ecosystems.
 *
 * Two functions:
 * - extractLanguagesFromQuery: detect language mentions in query text
 * - computeLangConcordance: score [0.3, 1.0] based on language match
 */

const LANGUAGE_ALIASES: Record<string, string[]> = {
  'node.js': ['javascript', 'typescript'],
  node: ['javascript', 'typescript'],
  nodejs: ['javascript', 'typescript'],
  react: ['javascript', 'typescript'],
  'react-native': ['javascript', 'typescript'],
  nextjs: ['javascript', 'typescript'],
  'next.js': ['javascript', 'typescript'],
  vue: ['javascript', 'typescript'],
  angular: ['javascript', 'typescript'],
  express: ['javascript', 'typescript'],
  fastify: ['javascript', 'typescript'],
  deno: ['javascript', 'typescript'],
  bun: ['javascript', 'typescript'],
  typescript: ['typescript', 'javascript'],
  javascript: ['javascript', 'typescript'],
  python: ['python'],
  django: ['python'],
  flask: ['python'],
  fastapi: ['python'],
  pytorch: ['python'],
  tensorflow: ['python'],
  java: ['java', 'kotlin'],
  kotlin: ['kotlin', 'java'],
  spring: ['java', 'kotlin'],
  go: ['go'],
  golang: ['go'],
  rust: ['rust'],
  ruby: ['ruby'],
  rails: ['ruby'],
  php: ['php'],
  laravel: ['php'],
  swift: ['swift'],
  'c#': ['c#'],
  dotnet: ['c#'],
  '.net': ['c#'],
  dart: ['dart'],
  flutter: ['dart'],
  elixir: ['elixir'],
};

/**
 * Detect language/framework mentions in a query and return normalized
 * lowercase language names.
 *
 * @example
 * extractLanguagesFromQuery("Node.js TypeScript ORM PostgreSQL")
 * // => ["javascript", "typescript"]
 *
 * extractLanguagesFromQuery("Docker container orchestration")
 * // => []
 */
export function extractLanguagesFromQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const langs = new Set<string>();

  // Check multi-char aliases that contain dots/hashes/hyphens (e.g. "node.js", "c#", "react-native")
  for (const [alias, mapped] of Object.entries(LANGUAGE_ALIASES)) {
    if (alias.includes('.') || alias.includes('-') || alias.includes('#')) {
      if (lower.includes(alias)) {
        for (const lang of mapped) {
          langs.add(lang);
        }
      }
    }
  }

  // Tokenize and check single-word aliases
  const tokens = lower.split(/[\s,;:()[\]{}]+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    const mapped = LANGUAGE_ALIASES[token];
    if (mapped) {
      for (const lang of mapped) {
        langs.add(lang);
      }
    }
  }

  return [...langs];
}

/**
 * Compute a concordance multiplier based on how well a tool's language
 * matches the target languages extracted from the query.
 *
 * - 1.0: exact match or no language constraint
 * - 0.8: cross-platform systems language (C, C++, Rust, shell) -- often has bindings
 * - 0.7: tool has no language info
 * - 0.3: different ecosystem entirely (e.g. PHP tool in a Node.js query)
 */
export function computeLangConcordance(
  toolLanguage: string,
  toolLanguages: string[],
  targetLangs: string[],
): number {
  if (targetLangs.length === 0) return 1.0; // no language constraint -> no penalty

  const primary = toolLanguage.toLowerCase();
  const all = toolLanguages.map((l) => l.toLowerCase());

  // Direct match on primary or any language
  if (targetLangs.some((t) => primary === t || all.includes(t))) return 1.0;

  // Cross-platform systems languages -- often have bindings for any ecosystem
  if (['c', 'c++', 'rust', 'shell', 'makefile', 'dockerfile'].includes(primary)) return 0.8;

  // Tool has no language info
  if (!primary || primary === 'unknown') return 0.7;

  // Different ecosystem entirely
  return 0.3;
}

/**
 * Acronym and alias expansion for BM25 search.
 * Maps common developer abbreviations to their full-text equivalents so
 * queries like "ORM" also match tools described as "object relational mapper".
 */

export const ALIAS_MAP: Record<string, string> = {
  orm: 'object relational mapper database',
  e2e: 'end-to-end testing',
  di: 'dependency injection',
  ioc: 'inversion of control',
  ci: 'continuous integration',
  cd: 'continuous deployment cicd',
  auth: 'authentication authorization',
  db: 'database',
  k8s: 'kubernetes container orchestration',
  ts: 'typescript',
  js: 'javascript',
  lsp: 'language server protocol',
  sdk: 'software development kit',
  api: 'application programming interface rest',
  cli: 'command line interface terminal',
  ssr: 'server side rendering',
  spa: 'single page application',
  cms: 'content management system',
  llm: 'large language model ai generative',
  ml: 'machine learning',
  ai: 'artificial intelligence neural',
  iac: 'infrastructure as code',
  ui: 'user interface component',
  ux: 'user experience design',
  regex: 'regular expression pattern matching',
  cron: 'scheduled task job scheduling',
  jwt: 'json web token authentication',
  oauth: 'oauth2 authentication authorization',
  graphql: 'graph query language api',
  grpc: 'remote procedure call protocol',
  wasm: 'webassembly binary compilation',
  pwa: 'progressive web app',
  cdn: 'content delivery network',
  dns: 'domain name system',
  ssl: 'tls https encryption certificate',
  mfa: '2fa two factor authentication',
  crud: 'create read update delete database',
  rpc: 'remote procedure call',
  etl: 'extract transform load data pipeline',
  nlp: 'natural language processing text',
};

/**
 * Expand a query by adding alias expansions for known abbreviations.
 * Original tokens are kept alongside their expansions.
 * Output is deduplicated to avoid inflating BM25 term frequency.
 */
export function expandQueryAliases(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    const expansion = ALIAS_MAP[token];
    if (expansion) {
      for (const term of expansion.split(' ')) {
        if (!expanded.includes(term)) expanded.push(term);
      }
    }
  }
  return expanded.join(' ');
}

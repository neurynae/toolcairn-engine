import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:batch-resolve' });

/** Category tags propagated to the MCP discovery pipeline for framework detection. */
const INTERESTING_CATEGORIES = new Set([
  'framework',
  'web-framework',
  'ui-framework',
  'meta-framework',
  'backend-framework',
  'frontend-framework',
  'mobile-framework',
  'database',
  'orm',
  'auth',
  'testing',
  'bundler',
  'linter',
  'formatter',
  'ci-cd',
  'package-manager',
  'runtime',
  'build-tool',
  'monitoring',
  'logging',
  'messaging',
  'cache',
]);

type BatchResolveInput = {
  api_version: '1';
  tools: Array<{
    name: string;
    ecosystem: string;
    canonical_package_name?: string;
    github_url?: string;
  }>;
};

type MatchMethod =
  | 'exact_github'
  | 'exact_channel'
  | 'channel_alias'
  | 'tool_name_exact'
  | 'tool_name_lowercase'
  | 'none';

type Resolved = {
  input: { name: string; ecosystem: string; github_url?: string };
  matched: boolean;
  match_method: MatchMethod;
  tool?: {
    canonical_name: string;
    github_url: string;
    categories: string[];
    match_confidence: number;
  };
};

interface QdrantPointPayload {
  name?: string;
  github_url?: string;
  category?: string;
  topics?: string[];
  registry_package_keys?: string[];
}

/** Build the downstream categories[] from the Tool node's category + filtered topics. */
function buildCategories(
  category: string | null | undefined,
  topics: string[] | null | undefined,
): string[] {
  const out: string[] = [];
  if (category) out.push(category);
  if (Array.isArray(topics)) {
    for (const t of topics) {
      const lower = t.toLowerCase();
      if (INTERESTING_CATEGORIES.has(lower) && !out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

function confidenceOf(method: MatchMethod): number {
  switch (method) {
    case 'exact_github':
      return 1.0;
    case 'exact_channel':
      return 1.0;
    case 'channel_alias':
      return 0.9;
    case 'tool_name_exact':
      return 0.8;
    case 'tool_name_lowercase':
      return 0.6;
    case 'none':
      return 0;
  }
}

/** Normalise a GitHub URL so it compares cleanly against the stored payload value. */
function normaliseGitHubUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (s.startsWith('git+')) s = s.slice(4);
  s = s.replace(/\/$/, '');
  s = s.replace(/\.git$/, '');
  s = s.replace(/^git@github\.com:/, 'https://github.com/');
  s = s.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  s = s.replace(/^http:\/\//, 'https://');
  return s;
}

/**
 * Tier 1: Qdrant filter by `registry_package_keys = "<registry>:<name>"`.
 * Uses canonical_package_name when the client provided it (authoritative
 * from the installed package manifest), falling back to the raw dep name.
 */
async function resolveViaRegistryKey(
  inputs: BatchResolveInput['tools'],
): Promise<Map<string, QdrantPointPayload>> {
  if (inputs.length === 0) return new Map();
  const keys = Array.from(
    new Set(inputs.map((i) => `${i.ecosystem}:${i.canonical_package_name ?? i.name}`)),
  );
  const client = qdrantClient();
  const result = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [{ key: 'registry_package_keys', match: { any: keys } }],
    },
    with_payload: ['name', 'github_url', 'category', 'topics', 'registry_package_keys'],
    with_vector: false,
    limit: Math.max(64, keys.length * 2),
  });
  const byKey = new Map<string, QdrantPointPayload>();
  for (const point of result.points ?? []) {
    const payload = (point.payload ?? {}) as QdrantPointPayload;
    for (const k of payload.registry_package_keys ?? []) {
      if (!byKey.has(k)) byKey.set(k, payload);
    }
  }
  return byKey;
}

/**
 * Tier 2: Qdrant filter by `github_url` exact match. Uses the client-supplied
 * github_url from the installed package manifest — unambiguous key when
 * present. Returns a map keyed by the normalised URL.
 */
async function resolveViaGitHubUrl(urls: string[]): Promise<Map<string, QdrantPointPayload>> {
  const normalised = Array.from(
    new Set(urls.map((u) => normaliseGitHubUrl(u)).filter((u): u is string => Boolean(u))),
  );
  if (normalised.length === 0) return new Map();

  const client = qdrantClient();
  const byUrl = new Map<string, QdrantPointPayload>();

  // `any` match on a single keyword field works for exact-string membership
  // and fans out to a single scroll call.
  const result = await client.scroll(COLLECTION_NAME, {
    filter: { must: [{ key: 'github_url', match: { any: normalised } }] },
    with_payload: ['name', 'github_url', 'category', 'topics'],
    with_vector: false,
    limit: Math.max(64, normalised.length * 2),
  });
  for (const point of result.points ?? []) {
    const payload = (point.payload ?? {}) as QdrantPointPayload;
    const url = normaliseGitHubUrl(payload.github_url);
    if (url && !byUrl.has(url)) byUrl.set(url, payload);
  }
  return byUrl;
}

/**
 * Tier 4: Memgraph name cascade (tool_name_exact → tool_name_lowercase).
 * Last-resort disambiguation — only for inputs Tier 1 and Tier 2 couldn't
 * resolve (pre-backfill points, tools missing both a channel entry and a
 * github_url, or edge cases the client couldn't probe locally).
 */
async function resolveViaMemgraphFallback(
  deps: ToolDeps,
  inputs: BatchResolveInput['tools'],
): Promise<
  Map<string, { payload: QdrantPointPayload; method: 'tool_name_exact' | 'tool_name_lowercase' }>
> {
  const out = new Map<
    string,
    { payload: QdrantPointPayload; method: 'tool_name_exact' | 'tool_name_lowercase' }
  >();
  if (inputs.length === 0) return out;
  const rowsResult = await deps.graphRepo.batchResolve(inputs);
  if (!rowsResult.ok) {
    logger.warn(
      { err: rowsResult.error },
      'Memgraph fallback batchResolve failed — returning unresolved',
    );
    return out;
  }
  for (const row of rowsResult.data) {
    if (row.method === 'none' || !row.name || !row.github_url) continue;
    const key = `${row.input.ecosystem}:${row.input.name}`;
    out.set(key, {
      payload: {
        name: row.name,
        github_url: row.github_url,
        category: row.category ?? undefined,
        topics: row.topics ?? undefined,
      },
      method: row.method as 'tool_name_exact' | 'tool_name_lowercase',
    });
  }
  return out;
}

/**
 * Batch-resolve handler factory — cascading resolver.
 *
 * Tier 1 (Qdrant registry_package_keys):
 *   Primary lookup — uses client-supplied canonical_package_name when available
 *   (from installed package manifest), else the raw dep name. Hits are
 *   `exact_channel` with confidence 1.0.
 *
 * Tier 2 (Qdrant github_url):
 *   Unambiguous fallback using the repository URL the client pulled from the
 *   installed package's own manifest. Bypasses registry-key gaps entirely —
 *   every tool in the index has a github_url, so this is a near-perfect signal
 *   when the client can provide one. Hits are `exact_github` with confidence 1.0.
 *
 * Tier 4 (Memgraph Tool.name cascade):
 *   Last resort for inputs neither Qdrant tier resolved. Name-based cascade
 *   preserved for backward compatibility and offline-client scenarios.
 *
 * Tier 3 (HTTP registry API lookup) is reserved for a follow-up — not wired yet.
 *
 * On Qdrant failure: both Qdrant tiers skip and the whole batch falls through
 * to Memgraph with a warning. Primary store dependency but graceful-degrade.
 */
export function createBatchResolveHandler(deps: ToolDeps) {
  return async (args: BatchResolveInput) => {
    try {
      const inputs = args.tools;
      if (inputs.length === 0) {
        return okResult({ resolved: [] as Resolved[] });
      }
      logger.info(
        {
          count: inputs.length,
          with_canonical: inputs.filter((i) => i.canonical_package_name).length,
          with_github_url: inputs.filter((i) => i.github_url).length,
        },
        'batch_resolve called',
      );

      // ── Tier 1: registry_package_keys ────────────────────────────────────
      const tier1 = await resolveViaRegistryKey(inputs).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Qdrant Tier 1 (registry) lookup failed',
        );
        return new Map<string, QdrantPointPayload>();
      });

      // Collect leftovers for Tier 2 (those with a github_url to probe).
      const tier2Candidates = inputs.filter((i) => {
        const key = `${i.ecosystem}:${i.canonical_package_name ?? i.name}`;
        return !tier1.has(key) && i.github_url;
      });
      const tier2UrlList = tier2Candidates.map((i) => i.github_url as string);

      // ── Tier 2: github_url ───────────────────────────────────────────────
      const tier2 = await resolveViaGitHubUrl(tier2UrlList).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Qdrant Tier 2 (github_url) lookup failed',
        );
        return new Map<string, QdrantPointPayload>();
      });

      // Collect leftovers for Tier 4 Memgraph fallback.
      const tier4Candidates = inputs.filter((i) => {
        const key = `${i.ecosystem}:${i.canonical_package_name ?? i.name}`;
        if (tier1.has(key)) return false;
        const normUrl = normaliseGitHubUrl(i.github_url);
        if (normUrl && tier2.has(normUrl)) return false;
        return true;
      });

      // ── Tier 4: Memgraph cascade ─────────────────────────────────────────
      const tier4 = await resolveViaMemgraphFallback(deps, tier4Candidates);

      // Compose final resolved[] preserving input order.
      const resolved: Resolved[] = inputs.map((input) => {
        const regKey = `${input.ecosystem}:${input.canonical_package_name ?? input.name}`;
        const t1 = tier1.get(regKey);
        if (t1 && t1.name && t1.github_url) {
          return {
            input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
            matched: true,
            match_method: 'exact_channel',
            tool: {
              canonical_name: t1.name,
              github_url: t1.github_url,
              categories: buildCategories(t1.category, t1.topics),
              match_confidence: confidenceOf('exact_channel'),
            },
          };
        }
        const normUrl = normaliseGitHubUrl(input.github_url);
        const t2 = normUrl ? tier2.get(normUrl) : undefined;
        if (t2 && t2.name && t2.github_url) {
          return {
            input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
            matched: true,
            match_method: 'exact_github',
            tool: {
              canonical_name: t2.name,
              github_url: t2.github_url,
              categories: buildCategories(t2.category, t2.topics),
              match_confidence: confidenceOf('exact_github'),
            },
          };
        }
        const memKey = `${input.ecosystem}:${input.name}`;
        const t4 = tier4.get(memKey);
        if (t4 && t4.payload.name && t4.payload.github_url) {
          return {
            input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
            matched: true,
            match_method: t4.method,
            tool: {
              canonical_name: t4.payload.name,
              github_url: t4.payload.github_url,
              categories: buildCategories(t4.payload.category, t4.payload.topics),
              match_confidence: confidenceOf(t4.method),
            },
          };
        }
        return {
          input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
          matched: false,
          match_method: 'none',
        };
      });

      const stats = resolved.reduce(
        (acc, r) => {
          if (!r.matched) acc.none++;
          else if (r.match_method === 'exact_channel') acc.channel++;
          else if (r.match_method === 'exact_github') acc.github++;
          else acc.name++;
          return acc;
        },
        { channel: 0, github: 0, name: 0, none: 0 },
      );
      logger.info({ total: inputs.length, ...stats }, 'batch_resolve completed');

      return okResult({ resolved });
    } catch (e) {
      logger.error({ err: e }, 'batch_resolve failed');
      return errResult('batch_resolve_error', e instanceof Error ? e.message : String(e));
    }
  };
}

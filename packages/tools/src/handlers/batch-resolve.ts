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

type ResolvedPackageChannel = {
  registry: string;
  packageName: string;
  installCommand?: string;
  weeklyDownloads?: number;
};

type Resolved = {
  input: { name: string; ecosystem: string; github_url?: string };
  matched: boolean;
  match_method: MatchMethod;
  tool?: {
    canonical_name: string;
    github_url: string;
    categories: string[];
    match_confidence: number;
    /** Enrichment bundle — populated from the Memgraph pass on the same query. */
    description?: string | null;
    license?: string | null;
    homepage_url?: string | null;
    docs?: {
      readme_url?: string | null;
      docs_url?: string | null;
      api_url?: string | null;
      changelog_url?: string | null;
    };
    package_managers?: ResolvedPackageChannel[];
  };
};

/** Parse the Memgraph `package_managers` JSON string into a typed channel list. */
function parsePackageManagers(raw: string | null | undefined): ResolvedPackageChannel[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
      .map((c) => ({
        registry: String(c.registry ?? ''),
        packageName: String(c.packageName ?? ''),
        installCommand: typeof c.installCommand === 'string' ? c.installCommand : undefined,
        weeklyDownloads: typeof c.weeklyDownloads === 'number' ? c.weeklyDownloads : undefined,
      }))
      .filter((c) => c.registry && c.packageName);
  } catch {
    return [];
  }
}

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

      // ── Tier 1: registry_package_keys (Qdrant fast-path) ─────────────────
      const tier1 = await resolveViaRegistryKey(inputs).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Qdrant Tier 1 (registry) lookup failed',
        );
        return new Map<string, QdrantPointPayload>();
      });

      // ── Tier 2: github_url (Qdrant fallback, client-supplied URLs) ───────
      const tier2UrlList = inputs.filter((i) => i.github_url).map((i) => i.github_url as string);
      const tier2 = await resolveViaGitHubUrl(tier2UrlList).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Qdrant Tier 2 (github_url) lookup failed',
        );
        return new Map<string, QdrantPointPayload>();
      });

      // ── Single Memgraph pass for enrichment (hydrates EVERY match) ───────
      //
      // For each input we feed Memgraph the most authoritative github_url we
      // have: the one surfaced by Qdrant if a tier matched, otherwise the
      // client-supplied URL. The Cypher prefers `github_url` exact match over
      // name matching, so name collisions across ecosystems (npm:foo vs pypi:foo)
      // resolve correctly. One query returns canonical name + category + topics
      // + the FULL enrichment bundle (description / license / homepage / docs
      // links / package_managers JSON) for everything matched.
      const memgraphInputs = inputs.map((i) => {
        const regKey = `${i.ecosystem}:${i.canonical_package_name ?? i.name}`;
        const t1Url = tier1.get(regKey)?.github_url;
        const normClientUrl = normaliseGitHubUrl(i.github_url);
        const t2Url = normClientUrl ? tier2.get(normClientUrl)?.github_url : undefined;
        return {
          name: i.name,
          ecosystem: i.ecosystem,
          github_url: t1Url ?? t2Url ?? i.github_url,
        };
      });
      const memResult = await deps.graphRepo.batchResolve(memgraphInputs);
      if (!memResult.ok) {
        logger.warn(
          { err: memResult.error },
          'Memgraph batchResolve failed — enrichment will be missing',
        );
      }
      // Key by input-index to avoid ambiguity when duplicate (name, ecosystem)
      // tuples appear in the batch; the Cypher preserves input order via UNWIND.
      const memRows = memResult.ok ? memResult.data : [];

      // Compose final resolved[] preserving input order.
      const resolved: Resolved[] = inputs.map((input, idx) => {
        const regKey = `${input.ecosystem}:${input.canonical_package_name ?? input.name}`;
        const t1 = tier1.get(regKey);
        const normClientUrl = normaliseGitHubUrl(input.github_url);
        const t2 = normClientUrl ? tier2.get(normClientUrl) : undefined;
        const mem = memRows[idx];

        // Pick tier-preferred match_method: exact_channel > exact_github >
        // Memgraph's reported method > none. Enrichment always comes from
        // Memgraph when it matched, regardless of which Qdrant tier fired.
        let method: MatchMethod = 'none';
        let canonical_name: string | null = null;
        let github_url: string | null = null;
        if (t1?.name && t1.github_url) {
          method = 'exact_channel';
          canonical_name = t1.name;
          github_url = t1.github_url;
        } else if (t2?.name && t2.github_url) {
          method = 'exact_github';
          canonical_name = t2.name;
          github_url = t2.github_url;
        } else if (mem && mem.method !== 'none' && mem.name && mem.github_url) {
          method = mem.method;
          canonical_name = mem.name;
          github_url = mem.github_url;
        }

        if (!canonical_name || !github_url) {
          return {
            input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
            matched: false,
            match_method: 'none',
          };
        }

        const category = mem?.category ?? t1?.category ?? t2?.category ?? null;
        const topics = mem?.topics ?? t1?.topics ?? t2?.topics ?? null;

        return {
          input: { name: input.name, ecosystem: input.ecosystem, github_url: input.github_url },
          matched: true,
          match_method: method,
          tool: {
            canonical_name,
            github_url,
            categories: buildCategories(category, topics),
            match_confidence: confidenceOf(method),
            description: mem?.description ?? null,
            license: mem?.license ?? null,
            homepage_url: mem?.homepage_url ?? null,
            docs: {
              readme_url: mem?.docs_readme_url ?? null,
              docs_url: mem?.docs_docs_url ?? null,
              api_url: mem?.docs_api_url ?? null,
              changelog_url: mem?.docs_changelog_url ?? null,
            },
            package_managers: parsePackageManagers(mem?.package_managers ?? null),
          },
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

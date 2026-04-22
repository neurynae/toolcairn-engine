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
  tools: Array<{ name: string; ecosystem: string }>;
};

type MatchMethod =
  | 'exact_channel'
  | 'channel_alias'
  | 'tool_name_exact'
  | 'tool_name_lowercase'
  | 'none';

type Resolved = {
  input: { name: string; ecosystem: string };
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

/**
 * Resolve as many inputs as possible via Qdrant's `registry_package_keys`
 * payload index. One filter-scroll covers the entire batch in a single
 * round-trip. Returns a map: "<registry>:<name>" → matched point.
 */
async function resolveViaQdrant(
  inputs: Array<{ name: string; ecosystem: string }>,
): Promise<Map<string, QdrantPointPayload>> {
  if (inputs.length === 0) return new Map();
  const keys = Array.from(new Set(inputs.map((i) => `${i.ecosystem}:${i.name}`)));

  const client = qdrantClient();
  const result = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [
        {
          key: 'registry_package_keys',
          match: { any: keys },
        },
      ],
    },
    with_payload: ['name', 'github_url', 'category', 'topics', 'registry_package_keys'],
    with_vector: false,
    // Allow a little slack for rare multi-matches (one channel key owned by >1 tool).
    limit: Math.max(64, keys.length * 2),
  });

  const byKey = new Map<string, QdrantPointPayload>();
  for (const point of result.points ?? []) {
    const payload = (point.payload ?? {}) as QdrantPointPayload;
    for (const k of payload.registry_package_keys ?? []) {
      // First match wins — Qdrant scroll is non-deterministic across ties, but
      // collisions inside an ecosystem/package should be vanishingly rare.
      if (!byKey.has(k)) byKey.set(k, payload);
    }
  }
  return byKey;
}

/**
 * Memgraph fallback for inputs Qdrant couldn't resolve.
 * Runs ONLY for the leftover set — tools that somehow aren't in Qdrant,
 * or ecosystems whose channel key isn't in the payload yet (pre-backfill window).
 *
 * Cascades tool_name_exact → tool_name_lowercase. No exact_channel here — that
 * contract belongs exclusively to the Qdrant path (Cypher can't see the keys).
 */
async function resolveViaMemgraphFallback(
  deps: ToolDeps,
  inputs: Array<{ name: string; ecosystem: string }>,
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
 * Batch-resolve handler factory.
 *
 * Primary: Qdrant payload filter on `registry_package_keys` (exact_channel match,
 * confidence 1.0, O(log N) via keyword index).
 * Fallback: Memgraph Tool.name cascade (tool_name_exact → tool_name_lowercase)
 * for inputs Qdrant couldn't match.
 * None: returned when both tiers miss — caller classifies as non_oss.
 */
export function createBatchResolveHandler(deps: ToolDeps) {
  return async (args: BatchResolveInput) => {
    try {
      const inputs = args.tools;
      if (inputs.length === 0) {
        return okResult({ resolved: [] as Resolved[] });
      }
      logger.info({ count: inputs.length }, 'batch_resolve called');

      // Tier 1: Qdrant (exact_channel).
      const qdrantHits = await resolveViaQdrant(inputs).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Qdrant channel-key lookup failed — falling back to Memgraph for the whole batch',
        );
        return new Map<string, QdrantPointPayload>();
      });

      // Tier 2: Memgraph name-cascade for leftovers.
      const leftovers = inputs.filter((i) => !qdrantHits.has(`${i.ecosystem}:${i.name}`));
      const memgraphHits = await resolveViaMemgraphFallback(deps, leftovers);

      const resolved: Resolved[] = inputs.map((input) => {
        const key = `${input.ecosystem}:${input.name}`;
        const qd = qdrantHits.get(key);
        if (qd && qd.name && qd.github_url) {
          return {
            input,
            matched: true,
            match_method: 'exact_channel',
            tool: {
              canonical_name: qd.name,
              github_url: qd.github_url,
              categories: buildCategories(qd.category, qd.topics),
              match_confidence: confidenceOf('exact_channel'),
            },
          };
        }
        const mg = memgraphHits.get(key);
        if (mg && mg.payload.name && mg.payload.github_url) {
          return {
            input,
            matched: true,
            match_method: mg.method,
            tool: {
              canonical_name: mg.payload.name,
              github_url: mg.payload.github_url,
              categories: buildCategories(mg.payload.category, mg.payload.topics),
              match_confidence: confidenceOf(mg.method),
            },
          };
        }
        return { input, matched: false, match_method: 'none' };
      });

      const stats = resolved.reduce(
        (acc, r) => {
          if (!r.matched) acc.none++;
          else if (r.match_method === 'exact_channel') acc.channel++;
          else acc.name++;
          return acc;
        },
        { channel: 0, name: 0, none: 0 },
      );
      logger.info({ total: inputs.length, ...stats }, 'batch_resolve completed');

      return okResult({ resolved });
    } catch (e) {
      logger.error({ err: e }, 'batch_resolve failed');
      return errResult('batch_resolve_error', e instanceof Error ? e.message : String(e));
    }
  };
}

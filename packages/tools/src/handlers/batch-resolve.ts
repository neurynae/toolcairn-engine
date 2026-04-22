import type { PackageChannel } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:batch-resolve' });

/** Category tags the MCP discovery pipeline cares about for framework detection. */
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

function parsePackageManagers(raw: string | null): PackageChannel[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PackageChannel[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Derive a category array from the Tool node's `category` field + `topics`. */
function buildCategories(category: string | null, topics: string[] | null): string[] {
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
 * Batch-resolve handler factory.
 *
 * Accepts up to 500 (ecosystem, name) tuples. Returns one entry per input with
 * cascading match semantics:
 *   1. exact_channel — the matched Tool's `package_managers` contains an entry
 *      whose (registry, packageName) equals (input.ecosystem, input.name).
 *   2. tool_name_exact — input.name === Tool.name (from the Cypher query).
 *   3. tool_name_lowercase — case-insensitive name match.
 *   4. none — nothing matched; caller classifies as non_oss.
 */
export function createBatchResolveHandler(deps: ToolDeps) {
  return async (args: BatchResolveInput) => {
    try {
      const inputs = args.tools;
      if (inputs.length === 0) {
        return okResult({ resolved: [] as Resolved[] });
      }
      logger.info({ count: inputs.length }, 'batch_resolve called');

      const rowsResult = await deps.graphRepo.batchResolve(inputs);
      if (!rowsResult.ok) {
        return errResult('graph_error', rowsResult.error.message);
      }

      const resolved: Resolved[] = rowsResult.data.map((row) => {
        if (row.method === 'none' || !row.name || !row.github_url) {
          return {
            input: row.input,
            matched: false,
            match_method: 'none',
          };
        }

        const channels = parsePackageManagers(row.package_managers);
        const matchesChannel = channels.some(
          (pc) => pc.registry === row.input.ecosystem && pc.packageName === row.input.name,
        );

        const method: MatchMethod = matchesChannel ? 'exact_channel' : (row.method as MatchMethod);

        return {
          input: row.input,
          matched: true,
          match_method: method,
          tool: {
            canonical_name: row.name,
            github_url: row.github_url,
            categories: buildCategories(row.category, row.topics),
            match_confidence: confidenceOf(method),
          },
        };
      });

      const resolvedCount = resolved.filter((r) => r.matched).length;
      logger.info({ total: inputs.length, resolved: resolvedCount }, 'batch_resolve completed');

      return okResult({ resolved });
    } catch (e) {
      logger.error({ err: e }, 'batch_resolve failed');
      return errResult('batch_resolve_error', e instanceof Error ? e.message : String(e));
    }
  };
}

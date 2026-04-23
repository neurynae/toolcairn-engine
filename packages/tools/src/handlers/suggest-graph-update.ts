import { config } from '@toolcairn/config';
import type { EdgeType } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:suggest-graph-update' });

const VALID_EDGE_TYPES = new Set<EdgeType>([
  'SOLVES',
  'REQUIRES',
  'INTEGRATES_WITH',
  'REPLACES',
  'CONFLICTS_WITH',
  'POPULAR_WITH',
  'BREAKS_FROM',
  'COMPATIBLE_WITH',
]);

/**
 * Umbrella / monorepo repositories that host many unrelated packages.
 * A `github_url` pointing to one of these is almost always wrong at the
 * staging layer — the indexer cannot derive a canonical tool from the
 * umbrella root, so we reject at submission time instead of polluting
 * the staging queue with false leads.
 *
 * Keys are lowercase `owner/repo` strings for easy lookup.
 */
const UMBRELLA_BLOCKLIST = new Set<string>([
  'definitelytyped/definitelytyped',
  'npm/types',
  'microsoft/typescript-node-starter',
  'microsoft/vscode-extension-samples',
  // shadcn's /ui mono — individual components are not independent tools
  'shadcn-ui/ui',
]);

/** GitHub API call ceiling (defensive; real rate limit is 5000/hr with token). */
const VERIFY_TIMEOUT_MS = 8000;

/** Response fields we care about from GitHub's repo endpoint. */
interface RepoMeta {
  stars: number;
  archived: boolean;
  fork: boolean;
  owner_type: string | null;
  default_branch: string | null;
  pushed_at: string | null;
  normalised_url: string;
}

type VerifyResult =
  | { ok: true; meta: RepoMeta }
  | {
      ok: false;
      reason: string;
      code:
        | 'missing_url'
        | 'invalid_url'
        | 'umbrella'
        | 'not_found'
        | 'private'
        | 'archived'
        | 'api_error'
        | 'timeout';
    };

/**
 * Parse a GitHub URL (http(s), git@, or `github:owner/repo`) into owner/repo.
 * Returns null on anything we can't unambiguously interpret.
 */
function parseGithubUrl(raw: string): { owner: string; repo: string; canonical: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();

  // Strip prefixes: `git+`, protocol, `github:`
  let cleaned = trimmed.replace(/^git\+/, '');
  cleaned = cleaned.replace(/^github:/, 'https://github.com/');
  cleaned = cleaned.replace(/^git@github\.com:/, 'https://github.com/');
  cleaned = cleaned.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  cleaned = cleaned.replace(/^git:\/\/github\.com\//, 'https://github.com/');
  cleaned = cleaned.replace(/\.git$/, '');

  // Accept with or without https://
  if (!cleaned.startsWith('http')) cleaned = `https://${cleaned}`;

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return null;

  const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return {
    owner,
    repo,
    canonical: `https://github.com/${owner}/${repo}`,
  };
}

/**
 * Option-A verification: light, single GitHub API call per item.
 * Rejects items that clearly shouldn't be staged so the admin review queue
 * stays clean and the indexer doesn't waste a crawl slot on garbage.
 */
async function verifyStagingCandidate(githubUrl: string | undefined): Promise<VerifyResult> {
  if (!githubUrl) {
    return {
      ok: false,
      code: 'missing_url',
      reason: 'github_url is required for pre-stage verification',
    };
  }

  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid_url',
      reason: `github_url "${githubUrl}" does not parse as a GitHub repo URL`,
    };
  }

  const blocklistKey = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  if (UMBRELLA_BLOCKLIST.has(blocklistKey)) {
    return {
      ok: false,
      code: 'umbrella',
      reason: `${parsed.owner}/${parsed.repo} is an umbrella/monorepo — individual packages must be submitted with their own authoritative github_url`,
    };
  }

  const token = config.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'toolcairn-engine/suggest-graph-update',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('aborted') || message.toLowerCase().includes('timeout');
    return {
      ok: false,
      code: isTimeout ? 'timeout' : 'api_error',
      reason: `GitHub API unreachable for ${parsed.owner}/${parsed.repo}: ${message}`,
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      code: 'not_found',
      reason: `GitHub repo ${parsed.owner}/${parsed.repo} does not exist (404)`,
    };
  }
  if (res.status === 403 || res.status === 401) {
    return {
      ok: false,
      code: 'private',
      reason: `GitHub repo ${parsed.owner}/${parsed.repo} is not publicly accessible (HTTP ${res.status})`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'api_error',
      reason: `GitHub API returned HTTP ${res.status} for ${parsed.owner}/${parsed.repo}`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    stargazers_count?: number;
    archived?: boolean;
    fork?: boolean;
    owner?: { type?: string };
    default_branch?: string;
    pushed_at?: string;
  } | null;
  if (!body) {
    return {
      ok: false,
      code: 'api_error',
      reason: `GitHub returned an unreadable body for ${parsed.owner}/${parsed.repo}`,
    };
  }

  if (body.archived === true) {
    return {
      ok: false,
      code: 'archived',
      reason: `GitHub repo ${parsed.owner}/${parsed.repo} is archived — no longer maintained`,
    };
  }

  return {
    ok: true,
    meta: {
      stars: body.stargazers_count ?? 0,
      archived: false,
      fork: body.fork === true,
      owner_type: body.owner?.type ?? null,
      default_branch: body.default_branch ?? null,
      pushed_at: body.pushed_at ?? null,
      normalised_url: parsed.canonical,
    },
  };
}

export interface BatchToolItem {
  tool_name: string;
  github_url?: string;
  description?: string;
}

export function createSuggestGraphUpdateHandler(
  deps: Pick<ToolDeps, 'graphRepo' | 'prisma' | 'enqueueIndexJob'>,
) {
  return async function handleSuggestGraphUpdate(args: {
    suggestion_type: 'new_tool' | 'new_edge' | 'update_health' | 'new_use_case';
    data: {
      tool_name?: string;
      github_url?: string;
      description?: string;
      tools?: BatchToolItem[];
      relationship?: {
        source_tool: string;
        target_tool: string;
        edge_type: string;
        evidence?: string;
      };
      use_case?: {
        name: string;
        description: string;
        tools?: string[];
      };
    };
    query_id?: string;
    confidence?: number;
  }) {
    try {
      logger.info({ suggestion_type: args.suggestion_type }, 'suggest_graph_update called');

      const confidence = args.confidence ?? 0.5;
      const queryIds = args.query_id ? [args.query_id] : [];

      switch (args.suggestion_type) {
        case 'new_tool': {
          // Batch shape preferred when the agent drains `unknown_tools[]` from
          // toolcairn_init. Falls back to single-tool shape for legacy callers.
          const batch: BatchToolItem[] =
            Array.isArray(args.data.tools) && args.data.tools.length > 0
              ? args.data.tools
              : args.data.tool_name
                ? [
                    {
                      tool_name: args.data.tool_name,
                      github_url: args.data.github_url,
                      description: args.data.description,
                    },
                  ]
                : [];

          if (batch.length === 0) {
            return errResult(
              'missing_field',
              'new_tool suggestions require either data.tool_name (single) or data.tools[] (batch)',
            );
          }

          // Option-A verification: one GitHub API call per item, in parallel.
          // Rejected items are returned in the result array (not silently dropped)
          // so the agent can relay the reason back to the user.
          const verdicts = await Promise.all(
            batch.map((item) => verifyStagingCandidate(item.github_url)),
          );

          type ItemResult = {
            tool_name: string;
            verified: boolean;
            staged: boolean;
            staged_id?: string;
            index_queued: boolean;
            reason?: string;
            meta?: RepoMeta;
            error?: string;
          };

          const results: ItemResult[] = [];

          for (let i = 0; i < batch.length; i++) {
            const item = batch[i]!;
            const verdict = verdicts[i]!;
            if (!verdict.ok) {
              results.push({
                tool_name: item.tool_name,
                verified: false,
                staged: false,
                index_queued: false,
                reason: verdict.reason,
              });
              continue;
            }

            try {
              const staged = await deps.prisma.stagedNode.create({
                data: {
                  node_type: 'Tool',
                  node_data: {
                    name: item.tool_name,
                    github_url: verdict.meta.normalised_url,
                    description: item.description ?? null,
                    stars: verdict.meta.stars,
                    fork: verdict.meta.fork,
                    owner_type: verdict.meta.owner_type,
                  },
                  confidence,
                  source: 'ai_generated',
                  supporting_queries: queryIds,
                },
              });
              // Low-priority indexer hint. Real ingestion only happens on admin
              // approval (see /v1/admin/review/nodes/:id PATCH approve), which
              // enqueues at priority 1. This priority-2 hint exists so long-
              // running staging queues warm the indexer cache opportunistically.
              let indexQueued = false;
              const indexResult = await deps.enqueueIndexJob(verdict.meta.normalised_url, 2);
              indexQueued = indexResult.ok;
              results.push({
                tool_name: item.tool_name,
                verified: true,
                staged: true,
                staged_id: staged.id,
                index_queued: indexQueued,
                meta: verdict.meta,
              });
            } catch (itemErr) {
              results.push({
                tool_name: item.tool_name,
                verified: true,
                staged: false,
                index_queued: false,
                error: itemErr instanceof Error ? itemErr.message : String(itemErr),
              });
            }
          }

          const stagedCount = results.filter((r) => r.staged).length;
          const rejectedCount = results.filter((r) => !r.verified).length;
          const failedCount = results.length - stagedCount - rejectedCount;
          return okResult({
            staged: stagedCount > 0,
            auto_graduated: false,
            batch: results.length > 1,
            results,
            summary: {
              total: results.length,
              staged: stagedCount,
              rejected_by_verification: rejectedCount,
              staged_failed: failedCount,
            },
            message:
              results.length === 1
                ? results[0]!.staged
                  ? `Tool "${batch[0]!.tool_name}" verified + staged for admin review.`
                  : `Tool "${batch[0]!.tool_name}" rejected: ${results[0]!.reason ?? results[0]!.error}`
                : `${stagedCount}/${results.length} tools staged for admin review${rejectedCount > 0 ? ` (${rejectedCount} rejected pre-verification)` : ''}${failedCount > 0 ? ` (${failedCount} DB errors)` : ''}. All staged entries await admin approval before entering the live graph.`,
          });
        }

        case 'new_edge': {
          const rel = args.data.relationship;
          if (!rel) {
            return errResult(
              'missing_field',
              'data.relationship is required for new_edge suggestions',
            );
          }
          if (!VALID_EDGE_TYPES.has(rel.edge_type as EdgeType)) {
            return errResult(
              'invalid_edge_type',
              `Edge type "${rel.edge_type}" is not valid. Must be one of: ${Array.from(VALID_EDGE_TYPES).join(', ')}`,
            );
          }
          // Note: endpoint existence is still recorded on the staging row so the
          // admin reviewer sees which edges would graduate cleanly — but we NEVER
          // write to the live graph here. Admin review is the sole promotion path.
          const [existsSource, existsTarget] = await Promise.all([
            deps.graphRepo.toolExists(rel.source_tool),
            deps.graphRepo.toolExists(rel.target_tool),
          ]);
          const bothExist =
            existsSource.ok && existsSource.data && existsTarget.ok && existsTarget.data;

          const staged = await deps.prisma.stagedEdge.create({
            data: {
              edge_type: rel.edge_type,
              source_node_id: rel.source_tool,
              target_node_id: rel.target_tool,
              edge_data: { evidence: rel.evidence ?? null, both_tools_indexed: bothExist },
              confidence,
              source: 'ai_generated',
              supporting_queries: queryIds,
            },
          });
          return okResult({
            staged: true,
            staged_id: staged.id,
            auto_graduated: false,
            both_tools_indexed: bothExist,
            message: `Edge ${rel.source_tool} → ${rel.target_tool} (${rel.edge_type}) staged for admin review. Admin approval is required before it enters the live graph.`,
          });
        }

        case 'update_health': {
          const toolName = args.data.tool_name;
          if (!toolName) {
            return errResult('missing_field', 'data.tool_name is required for update_health');
          }
          const indexResult = await deps.enqueueIndexJob(toolName, 1);
          if (!indexResult.ok) {
            return errResult('queue_error', `Failed to enqueue re-index: ${indexResult.error}`);
          }
          return okResult({
            staged: false,
            auto_graduated: false,
            index_queued: true,
            message: `Re-indexing queued for "${toolName}". Updated health signals will be available in ~2 minutes.`,
          });
        }

        case 'new_use_case': {
          const uc = args.data.use_case;
          if (!uc) {
            return errResult(
              'missing_field',
              'data.use_case is required for new_use_case suggestions',
            );
          }
          const staged = await deps.prisma.stagedNode.create({
            data: {
              node_type: 'UseCase',
              node_data: { name: uc.name, description: uc.description, tools: uc.tools ?? [] },
              confidence,
              source: 'ai_generated',
              supporting_queries: queryIds,
            },
          });
          return okResult({
            staged: true,
            staged_id: staged.id,
            auto_graduated: false,
            message: `UseCase "${uc.name}" staged for review.`,
          });
        }
      }
    } catch (e) {
      logger.error({ err: e }, 'suggest_graph_update failed');
      return errResult('suggest_error', e instanceof Error ? e.message : String(e));
    }
  };
}

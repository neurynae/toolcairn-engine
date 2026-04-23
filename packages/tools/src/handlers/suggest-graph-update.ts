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

          const results = [] as Array<{
            tool_name: string;
            staged: boolean;
            staged_id?: string;
            index_queued: boolean;
            error?: string;
          }>;

          for (const item of batch) {
            try {
              const staged = await deps.prisma.stagedNode.create({
                data: {
                  node_type: 'Tool',
                  node_data: {
                    name: item.tool_name,
                    github_url: item.github_url ?? null,
                    description: item.description ?? null,
                  },
                  confidence,
                  source: 'ai_generated',
                  supporting_queries: queryIds,
                },
              });
              let indexQueued = false;
              if (item.github_url) {
                const indexResult = await deps.enqueueIndexJob(item.github_url, 2);
                indexQueued = indexResult.ok;
              }
              results.push({
                tool_name: item.tool_name,
                staged: true,
                staged_id: staged.id,
                index_queued: indexQueued,
              });
            } catch (itemErr) {
              results.push({
                tool_name: item.tool_name,
                staged: false,
                index_queued: false,
                error: itemErr instanceof Error ? itemErr.message : String(itemErr),
              });
            }
          }

          const stagedCount = results.filter((r) => r.staged).length;
          const failedCount = results.length - stagedCount;
          return okResult({
            staged: stagedCount > 0,
            auto_graduated: false,
            batch: results.length > 1,
            results,
            message:
              results.length === 1
                ? `Tool "${batch[0]!.tool_name}" staged for admin review. ${results[0]!.index_queued ? 'Indexing queued.' : ''}`
                : `${stagedCount}/${results.length} tools staged for admin review${failedCount > 0 ? ` (${failedCount} failed)` : ''}. All entries await admin approval before entering the live graph.`,
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

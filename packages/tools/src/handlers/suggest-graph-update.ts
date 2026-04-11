import type { EdgeType } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:suggest-graph-update' });

const AUTO_GRADUATE_THRESHOLD = 0.8;

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

export function createSuggestGraphUpdateHandler(
  deps: Pick<ToolDeps, 'graphRepo' | 'prisma' | 'enqueueIndexJob'>,
) {
  return async function handleSuggestGraphUpdate(args: {
    suggestion_type: 'new_tool' | 'new_edge' | 'update_health' | 'new_use_case';
    data: {
      tool_name?: string;
      github_url?: string;
      description?: string;
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
          const toolName = args.data.tool_name;
          if (!toolName) {
            return errResult(
              'missing_field',
              'data.tool_name is required for new_tool suggestions',
            );
          }
          const staged = await deps.prisma.stagedNode.create({
            data: {
              node_type: 'Tool',
              node_data: {
                name: toolName,
                github_url: args.data.github_url ?? null,
                description: args.data.description ?? null,
              },
              confidence,
              source: 'ai_generated',
              supporting_queries: queryIds,
            },
          });
          let indexQueued = false;
          if (args.data.github_url) {
            const indexResult = await deps.enqueueIndexJob(args.data.github_url, 2);
            indexQueued = indexResult.ok;
          }
          return okResult({
            staged: true,
            staged_id: staged.id,
            auto_graduated: false,
            index_queued: indexQueued,
            message: `Tool "${toolName}" staged for review. ${indexQueued ? 'Indexing queued — full data available in ~2 minutes.' : 'Provide github_url for automatic indexing.'}`,
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
          const [existsSource, existsTarget] = await Promise.all([
            deps.graphRepo.toolExists(rel.source_tool),
            deps.graphRepo.toolExists(rel.target_tool),
          ]);
          const bothExist =
            existsSource.ok && existsSource.data && existsTarget.ok && existsTarget.data;

          if (bothExist && confidence >= AUTO_GRADUATE_THRESHOLD) {
            const now = new Date().toISOString();
            const edgeResult = await deps.graphRepo.upsertEdge({
              type: rel.edge_type as EdgeType,
              source_id: rel.source_tool,
              target_id: rel.target_tool,
              properties: {
                weight: confidence * 0.8,
                confidence,
                last_verified: now,
                source: 'ai_generated',
                decay_rate: 0.05,
                evidence_count: 1,
                evidence_links: rel.evidence ? [rel.evidence] : [],
              },
            });
            if (edgeResult.ok) {
              return okResult({
                staged: false,
                auto_graduated: true,
                message: `Edge ${rel.source_tool} → ${rel.target_tool} (${rel.edge_type}) written directly to graph (confidence ${confidence} ≥ ${AUTO_GRADUATE_THRESHOLD}).`,
              });
            }
          }

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
            reason:
              confidence < AUTO_GRADUATE_THRESHOLD
                ? `Confidence ${confidence} < ${AUTO_GRADUATE_THRESHOLD} threshold — queued for human review`
                : 'One or both tools not yet in graph — queued for review',
            message: `Edge ${rel.source_tool} → ${rel.target_tool} (${rel.edge_type}) staged for review.`,
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

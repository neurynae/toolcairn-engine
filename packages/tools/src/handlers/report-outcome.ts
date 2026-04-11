import type { EdgeType } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import {
  buildDecrementEdgeWeightQuery,
  buildIncrementEdgeWeightQuery,
  getMemgraphSession,
} from '@toolcairn/graph';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:report-outcome' });

const WEIGHT_DELTA_SUCCESS = 0.05;
const WEIGHT_DELTA_FAILURE = 0.05;

async function adjustSolvesEdge(
  toolName: string,
  graphRepo: ToolDeps['graphRepo'],
  delta: number,
  direction: 'up' | 'down',
): Promise<void> {
  const toolResult = await graphRepo.findByName(toolName);
  if (!toolResult.ok || !toolResult.data) return;

  const edgeType: EdgeType = 'SOLVES';
  const session = getMemgraphSession();
  try {
    const { text, parameters } =
      direction === 'up'
        ? buildIncrementEdgeWeightQuery(edgeType, delta)
        : buildDecrementEdgeWeightQuery(edgeType, delta);
    await session.run(text, { ...parameters, name_a: toolName, name_b: toolName });
  } catch (e) {
    logger.warn({ err: e, tool: toolName }, 'Failed to adjust SOLVES edge weight');
  } finally {
    await session.close();
  }
}

async function stageReplacesEdge(
  prisma: ToolDeps['prisma'],
  oldTool: string,
  newTool: string,
  queryId: string,
): Promise<void> {
  try {
    await prisma.stagedEdge.create({
      data: {
        edge_type: 'REPLACES',
        source_node_id: newTool,
        target_node_id: oldTool,
        edge_data: {
          evidence: `User replaced ${oldTool} with ${newTool} in session ${queryId}`,
          confidence: 0.6,
        },
        confidence: 0.6,
        source: 'usage_data',
        supporting_queries: [queryId],
      },
    });
    logger.info({ old: oldTool, new: newTool }, 'REPLACES edge staged');
  } catch (e) {
    logger.warn({ err: e }, 'Failed to stage REPLACES edge');
  }
}

export function createReportOutcomeHandler(
  deps: Pick<ToolDeps, 'graphRepo' | 'prisma' | 'enqueueIndexJob'>,
) {
  return async function handleReportOutcome(args: {
    query_id: string;
    chosen_tool: string;
    reason?: string;
    outcome: 'success' | 'failure' | 'replaced' | 'pending';
    feedback?: string;
    replaced_by?: string;
    user_id?: string;
  }) {
    // Record user tool preference via Redis sorted set — fire-and-forget, before DB write
    // so it succeeds even if query_id FK constraint fails (query may not be in SearchSession yet)
    if (args.user_id) {
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
      import('ioredis')
        .then(({ Redis }) => {
          const r = new Redis(redisUrl, {
            lazyConnect: true,
            connectTimeout: 2000,
          });
          return r
            .connect()
            .then(() => r.zincrby(`user:${args.user_id}:tool_prefs`, 1, args.chosen_tool))
            .finally(() => r.disconnect());
        })
        .catch(() => undefined);
    }

    try {
      await deps.prisma.outcomeReport.create({
        data: {
          query_id: args.query_id,
          chosen_tool: args.chosen_tool,
          reason: args.reason,
          outcome: args.outcome,
          feedback: args.feedback,
        },
      });

      const graphActions: string[] = [];

      if (args.outcome === 'success') {
        adjustSolvesEdge(args.chosen_tool, deps.graphRepo, WEIGHT_DELTA_SUCCESS, 'up').catch(
          (e: unknown) => logger.warn({ err: e }, 'Background edge weight update failed'),
        );
        graphActions.push(`SOLVES weight +${WEIGHT_DELTA_SUCCESS} for ${args.chosen_tool}`);
      }

      if (args.outcome === 'failure') {
        adjustSolvesEdge(args.chosen_tool, deps.graphRepo, WEIGHT_DELTA_FAILURE, 'down').catch(
          (e: unknown) => logger.warn({ err: e }, 'Background edge weight update failed'),
        );
        const result = await deps.enqueueIndexJob(args.chosen_tool, 1);
        if (!result.ok) {
          logger.warn({ tool: args.chosen_tool, err: result.error }, 'Failed to enqueue re-index');
        }
        graphActions.push(
          `SOLVES weight -${WEIGHT_DELTA_FAILURE} for ${args.chosen_tool}`,
          're-index queued',
        );
      }

      if (args.outcome === 'replaced' && args.replaced_by) {
        stageReplacesEdge(deps.prisma, args.chosen_tool, args.replaced_by, args.query_id).catch(
          (e: unknown) => logger.warn({ err: e }, 'Background REPLACES staging failed'),
        );
        graphActions.push(`REPLACES edge staged: ${args.replaced_by} → ${args.chosen_tool}`);
      }

      logger.info(
        { query_id: args.query_id, outcome: args.outcome, graphActions },
        'Outcome recorded',
      );
      return okResult({ recorded: true, outcome: args.outcome, graph_actions: graphActions });
    } catch (e) {
      logger.error({ err: e, query_id: args.query_id }, 'Failed to record outcome');
      return errResult('storage_error', e instanceof Error ? e.message : String(e));
    }
  };
}

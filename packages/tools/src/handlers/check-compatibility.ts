import pino from 'pino';
import type { ToolDeps } from '../types.js';
import { errResult, okResult, resolveToolName } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:check-compatibility' });

const COMPATIBLE_TYPES = new Set(['COMPATIBLE_WITH', 'INTEGRATES_WITH', 'POPULAR_WITH']);
const CONFLICT_TYPES = new Set(['CONFLICTS_WITH', 'BREAKS_FROM']);
const REQUIRES_TYPES = new Set(['REQUIRES']);

type CompatibilityStatus = 'compatible' | 'conflicts' | 'requires' | 'unknown';

export function createCheckCompatibilityHandler(deps: Pick<ToolDeps, 'graphRepo'>) {
  return async function handleCheckCompatibility(args: { tool_a: string; tool_b: string }) {
    try {
      logger.info({ tool_a: args.tool_a, tool_b: args.tool_b }, 'check_compatibility called');

      // Fuzzy-resolve names so "nextjs" → "next.js", "mcpserver" → "mcp-server", etc.
      const [resolvedA, resolvedB] = await Promise.all([
        resolveToolName(args.tool_a, deps.graphRepo),
        resolveToolName(args.tool_b, deps.graphRepo),
      ]);

      if (resolvedA !== args.tool_a) {
        logger.info({ original: args.tool_a, resolved: resolvedA }, 'tool_a name resolved');
      }
      if (resolvedB !== args.tool_b) {
        logger.info({ original: args.tool_b, resolved: resolvedB }, 'tool_b name resolved');
      }

      const [existsA, existsB] = await Promise.all([
        deps.graphRepo.toolExists(resolvedA),
        deps.graphRepo.toolExists(resolvedB),
      ]);

      if (!existsA.ok || !existsA.data) {
        return errResult(
          'tool_not_found',
          `Tool "${args.tool_a}" not found in the ToolCairn index`,
        );
      }
      if (!existsB.ok || !existsB.data) {
        return errResult(
          'tool_not_found',
          `Tool "${args.tool_b}" not found in the ToolCairn index`,
        );
      }

      const edgesResult = await deps.graphRepo.getDirectEdges(resolvedA, resolvedB);
      if (!edgesResult.ok) {
        return errResult('graph_error', edgesResult.error.message);
      }

      const edges = edgesResult.data;
      let status: CompatibilityStatus = 'unknown';
      let confidence = 0.5;
      const signals: string[] = [];

      if (edges.length > 0) {
        confidence = Math.max(...edges.map((e) => e.confidence));
        if (edges.some((e) => CONFLICT_TYPES.has(e.edgeType))) {
          status = 'conflicts';
          signals.push(
            `Direct ${edges.find((e) => CONFLICT_TYPES.has(e.edgeType))?.edgeType} edge found`,
          );
        } else if (edges.some((e) => COMPATIBLE_TYPES.has(e.edgeType))) {
          status = 'compatible';
          signals.push(
            `Direct ${edges.find((e) => COMPATIBLE_TYPES.has(e.edgeType))?.edgeType} edge found`,
          );
        } else if (edges.some((e) => REQUIRES_TYPES.has(e.edgeType))) {
          status = 'requires';
          signals.push('Direct REQUIRES relationship found');
        }
      } else {
        const [neighborsA, neighborsB] = await Promise.all([
          deps.graphRepo.getRelated(args.tool_a, 10),
          deps.graphRepo.getRelated(args.tool_b, 10),
        ]);
        if (neighborsA.ok && neighborsB.ok) {
          const namesA = new Set(neighborsA.data.map((t) => t.name));
          const namesB = new Set(neighborsB.data.map((t) => t.name));
          const sharedNeighbors = [...namesA].filter((n) => namesB.has(n));
          if (sharedNeighbors.length >= 3) {
            status = 'compatible';
            confidence = 0.6;
            signals.push(
              `${sharedNeighbors.length} shared graph neighbors suggest these tools are used together`,
            );
          } else if (sharedNeighbors.length > 0) {
            status = 'unknown';
            confidence = 0.4;
            signals.push(
              `${sharedNeighbors.length} shared neighbors found — insufficient for strong inference`,
            );
          } else {
            signals.push(
              'No direct edges or shared neighbors — these tools may operate in different domains',
            );
          }
        }
      }

      const recommendation =
        status === 'compatible'
          ? `${args.tool_a} and ${args.tool_b} can be used together.`
          : status === 'conflicts'
            ? `${args.tool_a} and ${args.tool_b} have known conflicts. Avoid using them in the same project.`
            : status === 'requires'
              ? 'One of these tools requires the other. Check the direction of the REQUIRES edge.'
              : 'No direct compatibility data. These tools may work together but it has not been verified.';

      return okResult({
        tool_a: resolvedA,
        tool_b: resolvedB,
        status,
        confidence: Math.round(confidence * 100) / 100,
        direct_edges: edges.map((e) => ({
          type: e.edgeType,
          direction: e.direction,
          confidence: Math.round(e.confidence * 100) / 100,
          effective_weight: Math.round(e.effective_weight * 100) / 100,
        })),
        signals,
        recommendation,
        suggest_graph_update:
          status === 'unknown'
            ? 'If you discover compatibility data, call suggest_graph_update with suggestion_type: "new_edge" to contribute it back.'
            : null,
      });
    } catch (e) {
      logger.error({ err: e }, 'check_compatibility failed');
      return errResult('compatibility_error', e instanceof Error ? e.message : String(e));
    }
  };
}

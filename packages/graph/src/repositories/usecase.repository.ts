import type { ToolNode } from '@toolcairn/core';
import neo4j, { type Session } from 'neo4j-driver';
import { getMemgraphSession } from '../client.js';
import { mapRecordToToolNode } from '../queries/tool.queries.js';
import {
  FIND_TOOLS_BY_USE_CASES,
  GET_ALL_USE_CASES,
  MERGE_TOPIC_NODE,
  type TopicNodeType,
  UPSERT_BELONGS_TO_EDGE,
  UPSERT_FOLLOWS_EDGE,
  UPSERT_SOLVES_EDGE,
} from '../queries/usecase.queries.js';
import type { RepositoryError, TopicEdgeParams, UseCaseRepository } from './interfaces.js';

type UseCaseResult<T> = { ok: true; data: T } | { ok: false; error: RepositoryError };

export class MemgraphUseCaseRepository implements UseCaseRepository {
  private session(): Session {
    return getMemgraphSession();
  }

  async mergeTopicNode(node: {
    id: string;
    name: string;
    description: string;
    node_type: TopicNodeType;
    created_at: string;
    updated_at: string;
  }): Promise<UseCaseResult<void>> {
    const query = MERGE_TOPIC_NODE.forType(node.node_type);
    const session = this.session();
    try {
      await session.run(query.text, {
        id: node.id,
        name: node.name,
        description: node.description,
        created_at: node.created_at,
        updated_at: node.updated_at,
      });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async upsertTopicEdge(params: TopicEdgeParams): Promise<UseCaseResult<void>> {
    const edgeQuery =
      params.node_type === 'UseCase'
        ? UPSERT_SOLVES_EDGE
        : params.node_type === 'Pattern'
          ? UPSERT_FOLLOWS_EDGE
          : UPSERT_BELONGS_TO_EDGE;

    const session = this.session();
    try {
      await session.run(edgeQuery.text, {
        tool_id: params.tool_id,
        node_name: params.node_name,
        weight: params.weight,
        confidence: params.confidence,
        last_verified: params.last_verified,
        source: params.source,
        decay_rate: params.decay_rate,
      });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async findToolsByUseCases(names: string[], limit = 20): Promise<UseCaseResult<ToolNode[]>> {
    if (names.length === 0) return { ok: true, data: [] };
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOLS_BY_USE_CASES.text, {
        names,
        limit: neo4j.int(Math.floor(Number(limit))),
      });
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getAllUseCases(): Promise<
    UseCaseResult<Array<{ name: string; description: string; tool_count: number }>>
  > {
    const session = this.session();
    try {
      const result = await session.run(GET_ALL_USE_CASES.text);
      const useCases = result.records.map((r) => {
        const obj = r.toObject() as Record<string, unknown>;
        const toolCountRaw = obj.tool_count;
        const toolCount =
          toolCountRaw != null &&
          typeof toolCountRaw === 'object' &&
          'toNumber' in toolCountRaw &&
          typeof (toolCountRaw as { toNumber: () => number }).toNumber === 'function'
            ? (toolCountRaw as { toNumber: () => number }).toNumber()
            : Number(toolCountRaw ?? 0);
        return {
          name: String(obj.name ?? ''),
          description: String(obj.description ?? ''),
          tool_count: toolCount,
        };
      });
      return { ok: true, data: useCases };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }
}

import type { GraphEdge, ToolCategory, ToolNode } from '@toolcairn/core';
import neo4j, { type Session } from 'neo4j-driver';
import { getMemgraphSession } from '../client.js';
import {
  CREATE_TOOL,
  type CreateToolParams,
  DELETE_TOOL,
  FIND_TOOLS_BY_CATEGORIES,
  FIND_TOOLS_BY_CATEGORY,
  FIND_TOOL_BY_GITHUB_URL,
  FIND_TOOL_BY_NAME,
  GET_ALL_TOOL_NAMES,
  GET_DIRECT_EDGES_BETWEEN,
  GET_RELATED_TOOLS,
  GET_TOOL_NEIGHBORHOOD,
  TOOL_EXISTS,
  type UpsertEdgeParams,
  buildUpsertEdgeQuery,
  mapNeighborhoodRecords,
  mapRecordToToolNode,
} from '../queries/tool.queries.js';
import type { ToolNeighborhood } from '../queries/tool.queries.js';
import { FIND_TOOLS_BY_USE_CASES } from '../queries/usecase.queries.js';
import type { DirectEdge, RepositoryError, ToolRepository } from './interfaces.js';

type ToolResult<T> = { ok: true; data: T } | { ok: false; error: RepositoryError };

export class MemgraphToolRepository implements ToolRepository {
  private session(): Session {
    return getMemgraphSession();
  }

  async createTool(tool: ToolNode): Promise<ToolResult<ToolNode>> {
    const params: CreateToolParams = {
      id: tool.id,
      name: tool.name,
      display_name: tool.display_name,
      description: tool.description,
      category: tool.category,
      github_url: tool.github_url,
      homepage_url: tool.homepage_url ?? null,
      license: tool.license,
      language: tool.language,
      languages: tool.languages,
      deployment_models: tool.deployment_models,
      package_managers: JSON.stringify(tool.package_managers),
      health_stars: tool.health.stars,
      health_stars_velocity_90d: tool.health.stars_velocity_90d,
      health_last_commit_date: tool.health.last_commit_date,
      health_commit_velocity_30d: tool.health.commit_velocity_30d,
      health_open_issues: tool.health.open_issues,
      health_closed_issues_30d: tool.health.closed_issues_30d,
      health_pr_response_time_hours: tool.health.pr_response_time_hours,
      health_contributor_count: tool.health.contributor_count,
      health_contributor_trend: tool.health.contributor_trend,
      health_last_release_date: tool.health.last_release_date,
      health_maintenance_score: tool.health.maintenance_score,
      docs_readme_url: tool.docs.readme_url ?? null,
      docs_docs_url: tool.docs.docs_url ?? null,
      docs_api_url: tool.docs.api_url ?? null,
      docs_changelog_url: tool.docs.changelog_url ?? null,
      topics: tool.topics ?? [],
      created_at: tool.created_at,
      updated_at: tool.updated_at,
    };

    const session = this.session();
    try {
      const result = await session.run(CREATE_TOOL.text, params);
      const record = result.records[0];
      if (!record) {
        return { ok: false, error: { code: 'CREATE_FAILED', message: 'Failed to create tool' } };
      }
      return { ok: true, data: mapRecordToToolNode(record.toObject()) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async findByName(name: string): Promise<ToolResult<ToolNode | null>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOL_BY_NAME.text, { name });
      const record = result.records[0];
      if (!record) {
        return { ok: true, data: null };
      }
      return { ok: true, data: mapRecordToToolNode(record.toObject()) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async findByCategory(category: ToolCategory): Promise<ToolResult<ToolNode[]>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOLS_BY_CATEGORY.text, { category });
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async findByCategories(categories: ToolCategory[]): Promise<ToolResult<ToolNode[]>> {
    if (categories.length === 0) return { ok: true, data: [] };
    if (categories.length === 1) return this.findByCategory(categories[0] as ToolCategory);
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOLS_BY_CATEGORIES.text, { categories });
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  /** Find tools that have any of the given topics in their topics array */
  async findByTopics(topics: string[]): Promise<ToolResult<ToolNode[]>> {
    if (topics.length === 0) return { ok: true, data: [] };
    const session = this.session();
    try {
      const QUERY =
        'MATCH (t:Tool) WHERE ANY(topic IN t.topics WHERE topic IN $topics) RETURN t ORDER BY t.health_maintenance_score DESC';
      const result = await session.run(QUERY, { topics });
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async upsertEdge(edge: GraphEdge): Promise<ToolResult<void>> {
    const params: UpsertEdgeParams = {
      type: edge.type,
      source_id: edge.source_id,
      target_id: edge.target_id,
      weight: edge.properties.weight,
      confidence: edge.properties.confidence,
      last_verified: edge.properties.last_verified,
      source: edge.properties.source,
      decay_rate: edge.properties.decay_rate,
      evidence_count: edge.properties.evidence_count,
      evidence_links: edge.properties.evidence_links,
    };
    const query = buildUpsertEdgeQuery(params);
    const session = this.session();
    try {
      await session.run(query.text, query.parameters);
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getRelated(toolName: string, depth = 3): Promise<ToolResult<ToolNode[]>> {
    const session = this.session();
    try {
      const result = await session.run(GET_RELATED_TOOLS.text, { name: toolName, depth });
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getToolNeighborhood(name: string): Promise<ToolResult<ToolNeighborhood | null>> {
    const session = this.session();
    try {
      const result = await session.run(GET_TOOL_NEIGHBORHOOD.text, { name });
      if (result.records.length === 0) return { ok: true, data: null };
      const records = result.records.map((r) => r.toObject());
      const neighborhood = mapNeighborhoodRecords(records);
      return { ok: true, data: neighborhood };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async deleteTool(name: string): Promise<ToolResult<void>> {
    const session = this.session();
    try {
      await session.run(DELETE_TOOL.text, { name });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async toolExists(name: string): Promise<ToolResult<boolean>> {
    const session = this.session();
    try {
      const result = await session.run(TOOL_EXISTS.text, { name });
      const count = result.records[0]?.get('count').toInt() ?? 0;
      return { ok: true, data: count > 0 };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getDirectEdges(nameA: string, nameB: string): Promise<ToolResult<DirectEdge[]>> {
    const session = this.session();
    try {
      const result = await session.run(GET_DIRECT_EDGES_BETWEEN.text, {
        name_a: nameA,
        name_b: nameB,
      });
      if (result.records.length === 0) return { ok: true, data: [] };

      const record = result.records[0];
      const raw = record?.get('edges');
      if (!Array.isArray(raw)) return { ok: true, data: [] };

      const edges: DirectEdge[] = raw
        .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
        .map((e) => ({
          edgeType: String(e.edgeType ?? ''),
          weight: Number(e.weight ?? 0),
          effective_weight: Number(e.effective_weight ?? 0),
          confidence: Number(e.confidence ?? 0),
          direction: (e.direction === 'b_to_a' ? 'b_to_a' : 'a_to_b') as 'a_to_b' | 'b_to_a',
        }));

      return { ok: true, data: edges };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getAllToolNames(): Promise<ToolResult<string[]>> {
    const session = this.session();
    try {
      const result = await session.run(GET_ALL_TOOL_NAMES.text);
      const names = result.records.map((r) => String(r.get('name')));
      return { ok: true, data: names };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async findByUseCases(useCaseNames: string[], limit = 20): Promise<ToolResult<ToolNode[]>> {
    if (useCaseNames.length === 0) return { ok: true, data: [] };
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOLS_BY_USE_CASES.text, {
        names: useCaseNames,
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

  async findByGitHubUrl(urlFragment: string): Promise<ToolResult<ToolNode | null>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_TOOL_BY_GITHUB_URL.text, { fragment: urlFragment });
      const record = result.records[0];
      if (!record) return { ok: true, data: null };
      return { ok: true, data: mapRecordToToolNode(record.toObject()) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }
}

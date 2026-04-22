import type { GraphEdge, ToolCategory, ToolNode } from '@toolcairn/core';
import neo4j, { type Session } from 'neo4j-driver';
import { getMemgraphSession } from '../client.js';
import {
  CREATE_TOOL,
  type CreateToolParams,
  DELETE_TOOL,
  FIND_ALL_TOOLS,
  FIND_TOOLS_BY_CATEGORIES,
  FIND_TOOLS_BY_CATEGORY,
  FIND_TOOL_BY_GITHUB_URL,
  FIND_TOOL_BY_NAME,
  FIND_TOP_TOOLS_BY_STARS,
  FIND_TOP_TOOLS_BY_STARS_VELOCITY,
  GET_ALL_TOOL_NAMES,
  GET_DIRECT_EDGES_BETWEEN,
  GET_PAIRWISE_EDGES,
  GET_RELATED_TOOLS,
  GET_RUNTIME_CONSTRAINTS,
  GET_STACK_VERSION_EDGES,
  GET_STACK_VERSION_INFO,
  GET_TOOL_NEIGHBORHOOD,
  GET_TOOL_USE_CASES,
  GET_VERSION_COMPATIBILITY_BETWEEN,
  LINK_TOOL_VERSION,
  MERGE_VERSION_NODE,
  type PairwiseEdge,
  TOOL_EXISTS,
  type ToolUseCases,
  type UpsertEdgeParams,
  buildUpsertEdgeQuery,
  mapNeighborhoodRecords,
  mapRecordToToolNode,
} from '../queries/tool.queries.js';
import type { ToolNeighborhood } from '../queries/tool.queries.js';
import { FIND_TOOLS_BY_USE_CASES } from '../queries/usecase.queries.js';
import type {
  DirectEdge,
  RepositoryError,
  RuntimeConstraintRow,
  StackEdgeRow,
  StackVersionInfo,
  StackVersionRow,
  ToolRepository,
  UpsertVersionEdgeParams,
  UpsertVersionNodeParams,
  VersionCompatibilityRow,
} from './interfaces.js';

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
      owner_name: tool.owner_name ?? null,
      owner_type: tool.owner_type ?? null,
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
      health_credibility_score: tool.health.credibility_score,
      health_forks_count: tool.health.forks_count,
      health_stars_snapshot_at: tool.health.stars_snapshot_at,
      health_stars_velocity_7d: tool.health.stars_velocity_7d,
      health_stars_velocity_30d: tool.health.stars_velocity_30d,
      is_fork: tool.is_fork,
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

  /** Fetch every Tool node with no filters — used for the "all tools" listing. */
  async findAll(): Promise<ToolResult<ToolNode[]>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_ALL_TOOLS.text);
      const tools = result.records.map((r) => mapRecordToToolNode(r.toObject()));
      return { ok: true, data: tools };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  /** Top-N tools by absolute GitHub stars. Sort + limit pushed into Memgraph. */
  async findTopByStars(limit: number): Promise<ToolResult<ToolNode[]>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_TOP_TOOLS_BY_STARS.text, {
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

  /** Top-N tools by 90-day stars velocity. Sort + limit pushed into Memgraph. */
  async findTopByStarsVelocity(limit: number): Promise<ToolResult<ToolNode[]>> {
    const session = this.session();
    try {
      const result = await session.run(FIND_TOP_TOOLS_BY_STARS_VELOCITY.text, {
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

  async getPairwiseEdges(names: string[]): Promise<ToolResult<PairwiseEdge[]>> {
    if (names.length < 2) return { ok: true, data: [] };
    const session = this.session();
    try {
      const result = await session.run(GET_PAIRWISE_EDGES.text, { names });
      const edges: PairwiseEdge[] = result.records.map((r) => ({
        source: String(r.get('source')),
        target: String(r.get('target')),
        edgeType: String(r.get('edge_type')),
        effectiveWeight: Number(r.get('effective_weight') ?? 0.5),
      }));
      return { ok: true, data: edges };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getToolUseCases(names: string[]): Promise<ToolResult<ToolUseCases[]>> {
    if (names.length === 0) return { ok: true, data: [] };
    const session = this.session();
    try {
      const result = await session.run(GET_TOOL_USE_CASES.text, { names });
      const rows: ToolUseCases[] = result.records.map((r) => ({
        toolName: String(r.get('tool_name')),
        useCases: (r.get('use_cases') as string[]) ?? [],
      }));
      return { ok: true, data: rows };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  /** Unfiltered count of all Tool nodes in Memgraph — used for the public landing page stat. */
  async getTotalCount(): Promise<ToolResult<number>> {
    const session = this.session();
    try {
      const result = await session.run('MATCH (t:Tool) RETURN count(t) AS total');
      const record = result.records[0];
      if (!record) return { ok: true, data: 0 };
      const raw = record.get('total');
      // neo4j-driver returns integers as { low, high } objects — unwrap with toNumber()
      const total =
        typeof raw === 'object' && raw !== null && 'low' in raw
          ? (raw as { low: number; high: number }).low
          : Number(raw);
      return { ok: true, data: total };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async upsertVersion(params: UpsertVersionNodeParams): Promise<ToolResult<void>> {
    const session = this.session();
    try {
      await session.run(MERGE_VERSION_NODE.text, {
        id: params.id,
        tool_id: params.tool_id,
        version: params.version,
        registry: params.registry,
        package_name: params.package_name,
        release_date: params.release_date,
        is_stable: params.is_stable,
        is_latest: params.is_latest,
        deprecated: params.deprecated,
        peer_ranges_json: JSON.stringify(params.peer_ranges ?? {}),
        engines_json: JSON.stringify(params.engines ?? {}),
        source: params.source,
        created_at: new Date().toISOString(),
      });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async linkToolVersion(
    toolName: string,
    versionId: string,
    isLatest: boolean,
  ): Promise<ToolResult<void>> {
    const session = this.session();
    try {
      await session.run(LINK_TOOL_VERSION.text, {
        tool_name: toolName,
        version_id: versionId,
        is_latest: isLatest,
        last_verified: new Date().toISOString(),
      });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  /**
   * Upsert a Version→Tool edge (VERSION_COMPATIBLE_WITH or REQUIRES_RUNTIME).
   * Matches on Version.id and Tool.name because Version nodes don't share the
   * same "name" property — uses a bespoke Cypher instead of buildUpsertEdgeQuery.
   */
  async upsertVersionEdge(params: UpsertVersionEdgeParams): Promise<ToolResult<void>> {
    const session = this.session();
    try {
      const text = `MATCH (v:Version { id: $source_version_id })
         MATCH (t:Tool { name: $target_tool_name })
         MERGE (v)-[e:${params.edge_type}]->(t)
         SET e.range = $range,
             e.range_system = $range_system,
             e.kind = $kind,
             e.source = $source,
             e.confidence = $confidence,
             e.last_verified = $last_verified,
             e.weight = 1.0,
             e.decay_rate = 0.0`;
      await session.run(text, {
        source_version_id: params.source_version_id,
        target_tool_name: params.target_tool_name,
        range: params.range,
        range_system: params.range_system,
        kind: params.kind,
        source: params.source,
        confidence: params.confidence,
        last_verified: params.last_verified,
      });
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getVersionCompatibilityBetween(
    nameA: string,
    nameB: string,
    versionA?: string,
    versionB?: string,
  ): Promise<ToolResult<VersionCompatibilityRow | null>> {
    const session = this.session();
    try {
      const result = await session.run(GET_VERSION_COMPATIBILITY_BETWEEN.text, {
        name_a: nameA,
        name_b: nameB,
        ver_a: versionA ?? null,
        ver_b: versionB ?? null,
      });
      const record = result.records[0];
      if (!record) return { ok: true, data: null };
      const a_to_b_range = record.get('a_to_b_range');
      const b_to_a_range = record.get('b_to_a_range');
      const a_runtime_b_range = record.get('a_runtime_b_range');
      const b_runtime_a_range = record.get('b_runtime_a_range');
      const row: VersionCompatibilityRow = {
        version_a: record.get('version_a') ?? null,
        version_b: record.get('version_b') ?? null,
        registry_a: record.get('registry_a') ?? null,
        registry_b: record.get('registry_b') ?? null,
        a_to_b: a_to_b_range
          ? {
              range: a_to_b_range,
              range_system: record.get('a_to_b_range_system'),
              kind: record.get('a_to_b_kind') ?? 'dep',
              source: record.get('a_to_b_source') ?? 'declared_dependency',
            }
          : null,
        b_to_a: b_to_a_range
          ? {
              range: b_to_a_range,
              range_system: record.get('b_to_a_range_system'),
              kind: record.get('b_to_a_kind') ?? 'dep',
              source: record.get('b_to_a_source') ?? 'declared_dependency',
            }
          : null,
        a_runtime_b: a_runtime_b_range
          ? {
              range: a_runtime_b_range,
              range_system: record.get('a_runtime_b_range_system'),
              source: record.get('a_runtime_b_source') ?? 'declared_dependency',
            }
          : null,
        b_runtime_a: b_runtime_a_range
          ? {
              range: b_runtime_a_range,
              range_system: record.get('b_runtime_a_range_system'),
              source: record.get('b_runtime_a_source') ?? 'declared_dependency',
            }
          : null,
      };
      return { ok: true, data: row };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getRuntimeConstraints(
    toolName: string,
    version?: string,
  ): Promise<ToolResult<RuntimeConstraintRow[]>> {
    const session = this.session();
    try {
      const result = await session.run(GET_RUNTIME_CONSTRAINTS.text, {
        tool_name: toolName,
        version: version ?? null,
      });
      const rows: RuntimeConstraintRow[] = [];
      for (const record of result.records) {
        const runtime = record.get('runtime');
        if (!runtime) continue;
        rows.push({
          version: record.get('version'),
          runtime,
          range: record.get('range') ?? '',
          range_system: record.get('range_system') ?? 'opaque',
          source: record.get('source') ?? 'declared_dependency',
        });
      }
      return { ok: true, data: rows };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await session.close();
    }
  }

  async getStackVersionInfo(names: string[]): Promise<ToolResult<StackVersionInfo>> {
    if (!names.length) return { ok: true, data: { versions: [], edges: [] } };
    const versionsSession = this.session();
    const edgesSession = this.session();
    try {
      const [vRes, eRes] = await Promise.all([
        versionsSession.run(GET_STACK_VERSION_INFO.text, { names }),
        edgesSession.run(GET_STACK_VERSION_EDGES.text, { names }),
      ]);
      const versions: StackVersionRow[] = [];
      for (const rec of vRes.records) {
        const version = rec.get('version');
        if (!version) continue;
        versions.push({
          tool: rec.get('tool'),
          version,
          registry: rec.get('registry'),
          release_date: rec.get('release_date'),
          is_stable: rec.get('is_stable') ?? true,
          is_latest: rec.get('is_latest') === true,
        });
      }
      const edges: StackEdgeRow[] = [];
      for (const rec of eRes.records) {
        edges.push({
          from_tool: rec.get('from_tool'),
          from_version: rec.get('from_version'),
          from_registry: rec.get('from_registry'),
          to_tool: rec.get('to_tool'),
          edge_type: rec.get('edge_type') as StackEdgeRow['edge_type'],
          range: rec.get('range') ?? '*',
          range_system: rec.get('range_system') ?? 'opaque',
          kind: rec.get('kind') ?? null,
          source: rec.get('source') ?? 'declared_dependency',
        });
      }
      return { ok: true, data: { versions, edges } };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    } finally {
      await versionsSession.close();
      await edgesSession.close();
    }
  }
}

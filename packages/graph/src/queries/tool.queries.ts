// Tool Cypher queries — all parameterized values.
// Relationship types use template literal for safe string interpolation.

import type { EdgeSource, EdgeType, PackageChannel, ToolNode } from '@toolcairn/core';
// PackageChannel is used in the package_managers deserialisation below.

// ─── Parameter interfaces ────────────────────────────────────────────────────

export interface CreateToolParams {
  id: string;
  name: string;
  display_name: string;
  description: string;
  category: string;
  github_url: string;
  homepage_url: string | null;
  owner_name: string | null;
  owner_type: string | null;
  license: string;
  language: string;
  languages: string[];
  deployment_models: string[];
  package_managers: string; // JSON-serialized PackageChannel[]
  health_stars: number;
  health_stars_velocity_90d: number;
  health_last_commit_date: string;
  health_commit_velocity_30d: number;
  health_open_issues: number;
  health_closed_issues_30d: number;
  health_pr_response_time_hours: number;
  health_contributor_count: number;
  health_contributor_trend: number;
  health_last_release_date: string;
  health_maintenance_score: number;
  health_credibility_score: number;
  health_forks_count: number;
  health_stars_snapshot_at: string;
  health_stars_velocity_7d: number;
  health_stars_velocity_30d: number;
  is_fork: boolean;
  docs_readme_url: string | null;
  docs_docs_url: string | null;
  docs_api_url: string | null;
  docs_changelog_url: string | null;
  topics: string[];
  created_at: string;
  updated_at: string;
}

export interface UpsertEdgeParams {
  type: EdgeType;
  source_id: string;
  target_id: string;
  weight: number;
  confidence: number;
  last_verified: string;
  source: EdgeSource;
  decay_rate: number;
  evidence_count?: number;
  evidence_links?: string[];
}

export interface FindByNameParams {
  name: string;
}

export interface FindByCategoryParams {
  category: string;
}

export interface GetRelatedParams {
  name: string;
  depth: number;
}

// ─── Query builders ───────────────────────────────────────────────────────────

/** Safe MERGE pattern for an edge — relationship type is interpolated directly. */
export function buildUpsertEdgeQuery(params: UpsertEdgeParams): {
  text: string;
  parameters: Record<string, unknown>;
} {
  // Relationship type must appear as literal token in MERGE pattern.
  // It comes from EdgeType enum which is controlled by internal code.
  return {
    text: `MATCH (source { id: $source_id })
     MATCH (target { id: $target_id })
     MERGE (source)-[e:${params.type}]->(target)
     SET e.weight = $weight,
         e.confidence = $confidence,
         e.last_verified = $last_verified,
         e.source = $source,
         e.decay_rate = $decay_rate,
         e.evidence_count = $evidence_count,
         e.evidence_links = $evidence_links`,
    parameters: {
      source_id: params.source_id,
      target_id: params.target_id,
      weight: params.weight,
      confidence: params.confidence,
      last_verified: params.last_verified,
      source: params.source,
      decay_rate: params.decay_rate,
      evidence_count: params.evidence_count ?? 0,
      evidence_links: params.evidence_links ?? [],
    },
  };
}

// ─── Static query strings ─────────────────────────────────────────────────────

export const CREATE_TOOL = {
  text: `MERGE (t:Tool { github_url: $github_url })
   ON CREATE SET t.grace_until = NULL,
                 t.grace_retries = 0,
                 t.ecosystem_centrality = 0,
                 t.pagerank_score = 0,
                 t.search_weight = 1.0,
                 t.is_canonical = false
   SET t.id = $id,
       t.display_name = $display_name,
       t.description = $description,
       t.category = $category,
       t.github_url = $github_url,
       t.homepage_url = $homepage_url,
       t.owner_name = $owner_name,
       t.owner_type = $owner_type,
       t.license = $license,
       t.language = $language,
       t.languages = $languages,
       t.deployment_models = $deployment_models,
       t.package_managers = $package_managers,
       t.health_stars = $health_stars,
       t.health_stars_velocity_90d = $health_stars_velocity_90d,
       t.health_last_commit_date = $health_last_commit_date,
       t.health_commit_velocity_30d = $health_commit_velocity_30d,
       t.health_open_issues = $health_open_issues,
       t.health_closed_issues_30d = $health_closed_issues_30d,
       t.health_pr_response_time_hours = $health_pr_response_time_hours,
       t.health_contributor_count = $health_contributor_count,
       t.health_contributor_trend = $health_contributor_trend,
       t.health_last_release_date = $health_last_release_date,
       t.health_maintenance_score = $health_maintenance_score,
       t.health_credibility_score = $health_credibility_score,
       t.health_forks_count = $health_forks_count,
       t.health_stars_snapshot_at = $health_stars_snapshot_at,
       t.health_stars_velocity_7d = $health_stars_velocity_7d,
       t.health_stars_velocity_30d = $health_stars_velocity_30d,
       t.is_fork = $is_fork,
       t.docs_readme_url = $docs_readme_url,
       t.docs_docs_url = $docs_docs_url,
       t.docs_api_url = $docs_api_url,
       t.docs_changelog_url = $docs_changelog_url,
       t.topics = $topics,
       t.created_at = $created_at,
       t.updated_at = $updated_at
   RETURN t`,
};

export const FIND_TOOL_BY_NAME = {
  text: 'MATCH (t:Tool { name: $name }) RETURN t',
};

export const FIND_TOOL_BY_GITHUB_URL = {
  text: 'MATCH (t:Tool) WHERE t.github_url CONTAINS $fragment RETURN t LIMIT 1',
};

export const FIND_TOOLS_BY_CATEGORY = {
  text: `MATCH (t:Tool { category: $category })
   RETURN t
   ORDER BY t.health_maintenance_score DESC`,
};

export const FIND_TOOLS_BY_CATEGORIES = {
  text: `MATCH (t:Tool)
   WHERE t.category IN $categories
   RETURN t
   ORDER BY t.health_maintenance_score DESC`,
};

export const FIND_ALL_TOOLS = {
  text: `MATCH (t:Tool)
   RETURN t
   ORDER BY t.health_maintenance_score DESC`,
};

export const FIND_TOOLS_BY_TOPICS = {
  text: `MATCH (t:Tool)
   WHERE ANY(topic IN t.topics WHERE topic IN $topics)
   RETURN t
   ORDER BY t.health_maintenance_score DESC`,
};

export const GET_RELATED_TOOLS = {
  text: `MATCH (t:Tool { name: $name })-[e]-(related:Tool)
   WITH related, e,
        e.weight * exp(-e.decay_rate * CASE WHEN e.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e.last_verified)).day END) AS effective_weight
   RETURN related, effective_weight
   ORDER BY effective_weight DESC
   LIMIT $depth`,
};

export const GET_TOOL_CO_OCCURRENCES = {
  text: `MATCH (t:Tool { name: $name })-[e1]-(other:Tool)-[e2]-(co:Tool)
   WHERE co <> t AND e1.source = e2.source
   WITH co, count(*) AS co_occurrence_count
   ORDER BY co_occurrence_count DESC
   RETURN co
   LIMIT 20`,
};

export const DELETE_TOOL = {
  text: 'MATCH (t:Tool { name: $name }) DETACH DELETE t',
};

export const TOOL_EXISTS = {
  text: 'MATCH (t:Tool { name: $name }) RETURN count(t) AS count',
};

export const GET_ALL_TOOL_NAMES = {
  text: 'MATCH (t:Tool) RETURN t.name AS name ORDER BY t.name',
};

export const GET_TOOL_GRAPH_RERANK = {
  // Semantic + co-occurrence edges contribute to direct_score.
  // REQUIRES excluded (build deps inflate scores for unrelated packages like nock).
  // CO_OCCURS_WITH gets a reduced weight multiplier (0.5) since it's weaker signal.
  text: `MATCH (t:Tool)
WHERE t.name IN $names
OPTIONAL MATCH (t)-[e:COMPATIBLE_WITH|INTEGRATES_WITH|POPULAR_WITH|REPLACES|CO_OCCURS_WITH]-(related:Tool)
WHERE related.name IN $names
WITH t,
     sum(CASE WHEN e IS NULL THEN 0
          ELSE
            (CASE WHEN type(e) = 'CO_OCCURS_WITH' THEN 0.5 ELSE 1.0 END) *
            (CASE WHEN e.last_verified IS NULL THEN e.weight
                  ELSE e.weight * exp(-coalesce(e.decay_rate, 0.05) *
                       (datetime() - datetime(e.last_verified)).day)
             END)
     END) AS direct_score
OPTIONAL MATCH (t)-[:SOLVES]->(u:UseCase)<-[:SOLVES]-(other:Tool)
WHERE other.name IN $names AND other <> t
WITH t, direct_score, count(DISTINCT u) * 0.3 AS usecase_overlap
RETURN t,
  direct_score + usecase_overlap
  + coalesce(t.ecosystem_centrality, 0) * 0.1
  + coalesce(t.pagerank_score, 0) * 0.15
  AS graphScore
ORDER BY graphScore DESC`,
};

/** Fetch IDs of tools directly connected to a named tool for query expansion. */
export const GET_INTEGRATION_NEIGHBORS = {
  text: `MATCH (t:Tool {name: $name})
         -[:INTEGRATES_WITH|COMPATIBLE_WITH|POPULAR_WITH]->
         (related:Tool)
         RETURN related.id AS id
         LIMIT $limit`,
};

export const GET_TOOL_NEIGHBORHOOD = {
  text: `MATCH (t:Tool { name: $name })
   OPTIONAL MATCH (t)-[e]-(related:Tool)
   WITH t, related, e, type(e) AS edgeType,
        CASE WHEN e.last_verified IS NULL THEN e.weight
             ELSE e.weight * exp(-e.decay_rate * CASE WHEN e.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e.last_verified)).day END)
        END AS effectiveWeight
   RETURN t, related, edgeType, effectiveWeight, e.confidence AS confidence
   ORDER BY effectiveWeight DESC LIMIT 20`,
};

/**
 * Fetch all direct edges between two tools (bidirectional).
 * Returns edge type, base weight, effective weight, and direction.
 */
export const GET_DIRECT_EDGES_BETWEEN = {
  text: `MATCH (a:Tool { name: $name_a })
   MATCH (b:Tool { name: $name_b })
   OPTIONAL MATCH (a)-[e1]->(b)
   OPTIONAL MATCH (b)-[e2]->(a)
   WITH a, b,
        collect(CASE WHEN e1 IS NOT NULL THEN {
          edgeType: type(e1),
          weight: e1.weight,
          effective_weight: e1.weight * exp(-e1.decay_rate * CASE WHEN e1.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e1.last_verified)).day END),
          confidence: e1.confidence,
          direction: 'a_to_b'
        } END) AS forward,
        collect(CASE WHEN e2 IS NOT NULL THEN {
          edgeType: type(e2),
          weight: e2.weight,
          effective_weight: e2.weight * exp(-e2.decay_rate * CASE WHEN e2.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e2.last_verified)).day END),
          confidence: e2.confidence,
          direction: 'b_to_a'
        } END) AS reverse
   RETURN [x IN forward WHERE x IS NOT NULL] + [x IN reverse WHERE x IS NOT NULL] AS edges`,
};

/**
 * Increment an edge weight by delta (capped at 1.0) between two tools.
 * Only updates if the edge exists. Relationship type is interpolated safely from EdgeType enum.
 */
export function buildIncrementEdgeWeightQuery(
  edgeType: EdgeType,
  delta: number,
): { text: string; parameters: Record<string, unknown> } {
  return {
    text: `MATCH (a:Tool { name: $name_a })-[e:${edgeType}]->(b:Tool { name: $name_b })
     SET e.weight = CASE WHEN e.weight + $delta > 1.0 THEN 1.0 ELSE e.weight + $delta END,
         e.last_verified = $now`,
    parameters: { delta, now: new Date().toISOString() },
  };
}

/**
 * Decrement an edge weight by delta (floored at 0.0) between two tools.
 */
export function buildDecrementEdgeWeightQuery(
  edgeType: EdgeType,
  delta: number,
): { text: string; parameters: Record<string, unknown> } {
  return {
    text: `MATCH (a:Tool { name: $name_a })-[e:${edgeType}]->(b:Tool { name: $name_b })
     SET e.weight = CASE WHEN e.weight - $delta < 0.0 THEN 0.0 ELSE e.weight - $delta END,
         e.last_verified = $now`,
    parameters: { delta, now: new Date().toISOString() },
  };
}

export interface GetToolNeighborhoodParams {
  name: string;
}

// ─── Neighborhood types & mapper ──────────────────────────────────────────────

export interface ToolNeighborEdge {
  tool: ToolNode;
  edgeType: string;
  weight: number;
  confidence: number;
}

export interface ToolNeighborhood {
  center: ToolNode;
  neighbors: ToolNeighborEdge[];
}

function coerceNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (
    val != null &&
    typeof val === 'object' &&
    'toNumber' in val &&
    typeof (val as { toNumber: () => number }).toNumber === 'function'
  ) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val ?? 0);
}

export function mapNeighborhoodRecords(
  records: Array<Record<string, unknown>>,
): ToolNeighborhood | null {
  if (records.length === 0) return null;

  // Safe: we checked records.length > 0 above
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const first = records[0]!;
  const center = mapRecordToToolNode({ t: first.t });
  const neighbors: ToolNeighborEdge[] = [];

  for (const record of records) {
    if (record.related == null) continue;
    try {
      const tool = mapRecordToToolNode({ t: record.related });
      neighbors.push({
        tool,
        edgeType: String(record.edgeType ?? 'RELATED_TO'),
        weight: coerceNumber(record.effectiveWeight),
        confidence: coerceNumber(record.confidence),
      });
    } catch {
      // skip malformed records
    }
  }

  return { center, neighbors };
}

// ─── Result mappers ───────────────────────────────────────────────────────────

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`mapRecordToToolNode: field '${field}' expected string, got ${typeof value}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`mapRecordToToolNode: field '${field}' expected number, got ${typeof value}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`mapRecordToToolNode: field '${field}' expected array, got ${typeof value}`);
  }
  return value as string[];
}

export function mapRecordToToolNodeWithScore(record: Record<string, unknown>): {
  tool: ToolNode;
  graphScore: number;
} {
  // neo4j-driver may return Integer or BigInt — coerce to plain JS number
  // The query now returns "graphScore" (camelCase); support legacy "graph_score" too
  const raw = record.graphScore ?? record.graph_score;
  const graphScore =
    raw == null
      ? 0
      : typeof raw === 'bigint'
        ? Number(raw)
        : typeof (raw as { toNumber?: () => number }).toNumber === 'function'
          ? (raw as { toNumber: () => number }).toNumber()
          : Number(raw);
  return { tool: mapRecordToToolNode({ t: record.t }), graphScore };
}

export function mapRecordToToolNode(record: Record<string, unknown>): ToolNode {
  // neo4j-driver returns Node objects from record.toObject() — extract .properties
  const rawT = record.t as Record<string, unknown>;
  const t =
    rawT !== null &&
    typeof rawT === 'object' &&
    'properties' in rawT &&
    rawT.properties !== null &&
    typeof rawT.properties === 'object'
      ? (rawT.properties as Record<string, unknown>)
      : rawT;
  return {
    id: requireString(t.id, 't.id'),
    name: requireString(t.name, 't.name'),
    display_name: requireString(t.display_name, 't.display_name'),
    description: requireString(t.description, 't.description'),
    category: requireString(t.category, 't.category') as ToolNode['category'],
    github_url: requireString(t.github_url, 't.github_url'),
    homepage_url: typeof t.homepage_url === 'string' ? t.homepage_url : undefined,
    owner_name: typeof t.owner_name === 'string' ? t.owner_name : undefined,
    owner_type:
      t.owner_type === 'User' || t.owner_type === 'Organization' ? t.owner_type : undefined,
    license: requireString(t.license, 't.license'),
    language: requireString(t.language, 't.language'),
    languages: requireStringArray(t.languages, 't.languages'),
    deployment_models: requireStringArray(
      t.deployment_models,
      't.deployment_models',
    ) as ToolNode['deployment_models'],
    package_managers: (() => {
      try {
        return typeof t.package_managers === 'string'
          ? (JSON.parse(t.package_managers) as PackageChannel[])
          : ((t.package_managers ?? []) as PackageChannel[]);
      } catch {
        return [] as PackageChannel[];
      }
    })(),
    health: {
      stars: requireNumber(t.health_stars, 't.health_stars'),
      stars_velocity_90d: requireNumber(t.health_stars_velocity_90d, 't.health_stars_velocity_90d'),
      last_commit_date: requireString(t.health_last_commit_date, 't.health_last_commit_date'),
      commit_velocity_30d: requireNumber(
        t.health_commit_velocity_30d,
        't.health_commit_velocity_30d',
      ),
      open_issues: requireNumber(t.health_open_issues, 't.health_open_issues'),
      closed_issues_30d: requireNumber(t.health_closed_issues_30d, 't.health_closed_issues_30d'),
      pr_response_time_hours: requireNumber(
        t.health_pr_response_time_hours,
        't.health_pr_response_time_hours',
      ),
      contributor_count: requireNumber(t.health_contributor_count, 't.health_contributor_count'),
      contributor_trend: requireNumber(t.health_contributor_trend, 't.health_contributor_trend'),
      last_release_date: requireString(t.health_last_release_date, 't.health_last_release_date'),
      maintenance_score: requireNumber(t.health_maintenance_score, 't.health_maintenance_score'),
      credibility_score:
        typeof t.health_credibility_score === 'number' ? t.health_credibility_score : 0,
      forks_count: typeof t.health_forks_count === 'number' ? t.health_forks_count : 0,
      stars_snapshot_at:
        typeof t.health_stars_snapshot_at === 'string' ? t.health_stars_snapshot_at : '',
      stars_velocity_7d:
        typeof t.health_stars_velocity_7d === 'number' ? t.health_stars_velocity_7d : 0,
      stars_velocity_30d:
        typeof t.health_stars_velocity_30d === 'number' ? t.health_stars_velocity_30d : 0,
    },
    docs: {
      readme_url: typeof t.docs_readme_url === 'string' ? t.docs_readme_url : undefined,
      docs_url: typeof t.docs_docs_url === 'string' ? t.docs_docs_url : undefined,
      api_url: typeof t.docs_api_url === 'string' ? t.docs_api_url : undefined,
      changelog_url: typeof t.docs_changelog_url === 'string' ? t.docs_changelog_url : undefined,
    },
    topics: Array.isArray(t.topics) ? (t.topics as string[]) : [],
    is_fork: typeof t.is_fork === 'boolean' ? t.is_fork : false,
    ecosystem_centrality: typeof t.ecosystem_centrality === 'number' ? t.ecosystem_centrality : 0,
    pagerank_score: typeof t.pagerank_score === 'number' ? t.pagerank_score : 0,
    search_weight: typeof t.search_weight === 'number' ? t.search_weight : 1.0,
    is_canonical: typeof t.is_canonical === 'boolean' ? t.is_canonical : false,
    grace_until: typeof t.grace_until === 'string' ? t.grace_until : undefined,
    grace_retries: typeof t.grace_retries === 'number' ? t.grace_retries : 0,
    created_at: requireString(t.created_at, 't.created_at'),
    updated_at: requireString(t.updated_at, 't.updated_at'),
  };
}

/** Get tools that frequently co-occur with a given tool in user sessions. */
export const GET_CO_OCCURRING_TOOLS = {
  text: `
    MATCH (t:Tool {name: $name})-[e:CO_OCCURS_WITH]-(co:Tool)
    RETURN co, e.weight AS weight
    ORDER BY weight DESC
    LIMIT 10
  `,
};

/** Upsert a CO_OCCURS_WITH edge between two tools with the given weight. */
export const UPSERT_CO_OCCURS_EDGE = {
  text: `
    MATCH (a:Tool {name: $name_a}), (b:Tool {name: $name_b})
    MERGE (a)-[e:CO_OCCURS_WITH]-(b)
    ON CREATE SET e.weight = $weight, e.session_count = 1, e.last_seen = $now
    ON MATCH SET e.weight = e.weight + $weight, e.session_count = e.session_count + 1,
                 e.last_seen = $now
  `,
};

// ─── Stack composition queries ───────────────────────────────────────────────

/** Batch-fetch SOLVES→UseCase connections for a set of tools. */
export interface ToolUseCases {
  toolName: string;
  useCases: string[];
}

export const GET_TOOL_USE_CASES = {
  text: `MATCH (t:Tool)-[:SOLVES]->(u:UseCase)
WHERE t.name IN $names
RETURN t.name AS tool_name, collect(u.name) AS use_cases`,
};

/**
 * Fetch all edges between a set of tools (undirected, deduplicated).
 * Used by stack composition for integration affinity and REPLACES penalty.
 */
export interface PairwiseEdge {
  source: string;
  target: string;
  edgeType: string;
  effectiveWeight: number;
}

export const GET_PAIRWISE_EDGES = {
  text: `MATCH (a:Tool)-[e:INTEGRATES_WITH|COMPATIBLE_WITH|POPULAR_WITH|REPLACES|CONFLICTS_WITH|CO_OCCURS_WITH|REQUIRES]-(b:Tool)
WHERE a.name IN $names AND b.name IN $names AND a.name < b.name
RETURN a.name AS source, b.name AS target, type(e) AS edge_type,
       CASE WHEN e.last_verified IS NULL THEN coalesce(e.weight, 0.5)
            ELSE coalesce(e.weight, 0.5) * exp(-coalesce(e.decay_rate, 0.05) *
                 (datetime() - datetime(e.last_verified)).day)
       END AS effective_weight`,
};

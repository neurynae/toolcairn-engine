// Topology Cypher queries — for admin portal graph visualization and weight dashboard.
// All queries use parameterized values.

export interface TopologyParams {
  category: string; // '' for all categories
  nodeLimit: number; // max 500, default 200
}

export interface TopologyRow {
  sourceId: string;
  sourceName: string;
  sourceDisplayName: string;
  sourceCategory: string;
  sourceMaintenanceScore: number;
  sourceStars: number;
  targetId: string | null;
  edgeType: string | null;
  baseWeight: number | null;
  effectiveWeight: number | null;
  confidence: number | null;
  edgeSource: string | null;
}

export interface EdgeWeightSummaryRow {
  edgeType: string;
  avgEffectiveWeight: number;
  edgeCount: number;
}

/**
 * Fetch Tool nodes and their edges for graph mesh visualization.
 * Uses OPTIONAL MATCH so isolated nodes (no edges) still appear as rows with null target fields.
 * Computes temporal decay (effective_weight) inline at query time.
 * Only returns edges where both source and target are in the selected node set.
 */
export const GET_GRAPH_TOPOLOGY = {
  text: `MATCH (t:Tool)
WHERE $category = '' OR t.category = $category
WITH t LIMIT $nodeLimit
WITH collect(t) AS nodes
WITH nodes, [n IN nodes | n.id] AS nodeIds
UNWIND nodes AS t
OPTIONAL MATCH (t)-[e]-(related:Tool)
WHERE related.id IN nodeIds AND id(related) <> id(t)
WITH t, related, e,
     CASE WHEN e IS NULL THEN null
          WHEN e.last_verified IS NULL THEN e.weight
          ELSE e.weight * exp(-e.decay_rate *
               (datetime() - datetime(e.last_verified)).day)
     END AS effective_weight
RETURN
  t.id AS sourceId,
  t.name AS sourceName,
  t.display_name AS sourceDisplayName,
  t.category AS sourceCategory,
  t.health_maintenance_score AS sourceMaintenanceScore,
  t.health_stars AS sourceStars,
  related.id AS targetId,
  type(e) AS edgeType,
  e.weight AS baseWeight,
  effective_weight AS effectiveWeight,
  e.confidence AS confidence,
  e.source AS edgeSource`,
};

/**
 * Summarize all edges in the graph by type — for the weight dashboard.
 * Returns avg effective weight and count per edge type.
 */
export const GET_EDGE_WEIGHT_SUMMARY = {
  text: `MATCH ()-[e]->()
WITH type(e) AS edgeType,
     avg(e.weight * exp(-e.decay_rate *
         CASE WHEN e.last_verified IS NULL THEN 0 ELSE (datetime() - datetime(e.last_verified)).day END)) AS avgEffectiveWeight,
     count(e) AS edgeCount
RETURN edgeType, avgEffectiveWeight, edgeCount
ORDER BY edgeCount DESC`,
};

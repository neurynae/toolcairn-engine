// UseCase, Pattern, and Stack Cypher queries for the graph mesh.
// All queries use parameterized values.

export type TopicNodeType = 'UseCase' | 'Pattern' | 'Stack';

export interface CreateTopicNodeParams {
  id: string;
  name: string;
  description: string;
  node_type: TopicNodeType;
  created_at: string;
  updated_at: string;
}

/** MERGE a UseCase, Pattern, or Stack node by name (idempotent) */
export const MERGE_TOPIC_NODE = {
  // Uses dynamic label via apoc or inline — since Memgraph supports dynamic labels via MERGE with variable,
  // we use a labeled approach. Caller passes the label as part of the query text.
  // This function generates query text for the given node type.
  forType: (nodeType: TopicNodeType) => ({
    text: `MERGE (n:${nodeType} { name: $name })
SET n.id = COALESCE(n.id, $id),
    n.description = COALESCE(n.description, $description),
    n.created_at = COALESCE(n.created_at, $created_at),
    n.updated_at = $updated_at
RETURN n`,
  }),
};

/** MERGE a SOLVES edge: Tool -SOLVES-> UseCase */
export const UPSERT_SOLVES_EDGE = {
  text: `MATCH (t:Tool { id: $tool_id })
MATCH (u:UseCase { name: $node_name })
MERGE (t)-[e:SOLVES]->(u)
SET e.weight = $weight,
    e.confidence = $confidence,
    e.last_verified = $last_verified,
    e.source = $source,
    e.decay_rate = $decay_rate
RETURN e`,
};

/** MERGE a FOLLOWS edge: Tool -FOLLOWS-> Pattern */
export const UPSERT_FOLLOWS_EDGE = {
  text: `MATCH (t:Tool { id: $tool_id })
MATCH (p:Pattern { name: $node_name })
MERGE (t)-[e:FOLLOWS]->(p)
SET e.weight = $weight,
    e.confidence = $confidence,
    e.last_verified = $last_verified,
    e.source = $source,
    e.decay_rate = $decay_rate
RETURN e`,
};

/** MERGE a BELONGS_TO edge: Tool -BELONGS_TO-> Stack */
export const UPSERT_BELONGS_TO_EDGE = {
  text: `MATCH (t:Tool { id: $tool_id })
MATCH (s:Stack { name: $node_name })
MERGE (t)-[e:BELONGS_TO]->(s)
SET e.weight = $weight,
    e.confidence = $confidence,
    e.last_verified = $last_verified,
    e.source = $source,
    e.decay_rate = $decay_rate
RETURN e`,
};

/** Find tools that SOLVE any of the given use case names, ordered by relevance */
export const FIND_TOOLS_BY_USE_CASES = {
  text: `MATCH (t:Tool)-[e:SOLVES]->(u:UseCase)
WHERE u.name IN $names
WITH t, sum(
  e.weight * exp(-e.decay_rate *
    CASE WHEN e.last_verified IS NULL THEN 0
    ELSE (datetime() - datetime(e.last_verified)).day END)
) AS relevance
RETURN t, relevance
ORDER BY relevance DESC
LIMIT $limit`,
};

/** Find tools that match via any of UseCase/Pattern/Stack node names */
export const FIND_TOOLS_BY_TOPIC_NODES = {
  text: `MATCH (t:Tool)-[e]->(n)
WHERE n.name IN $names AND type(e) IN ['SOLVES', 'FOLLOWS', 'BELONGS_TO']
WITH t, sum(
  e.weight * exp(-e.decay_rate *
    CASE WHEN e.last_verified IS NULL THEN 0
    ELSE (datetime() - datetime(e.last_verified)).day END)
) AS relevance
RETURN t, relevance
ORDER BY relevance DESC
LIMIT $limit`,
};

/** Get all UseCase nodes with tool counts */
export const GET_ALL_USE_CASES = {
  text: `MATCH (u:UseCase)
OPTIONAL MATCH (t:Tool)-[:SOLVES]->(u)
WITH u, count(t) AS tool_count
RETURN u.name AS name, u.description AS description, tool_count
ORDER BY tool_count DESC`,
};

/**
 * Batch query: find UseCases that co-occur with the given UseCases on the same tools.
 * Used by the multi-facet stack builder to discover IMPLICIT layers.
 * E.g. "ecommerce" primary facet → co-occurring: "payments", "stripe", "shopping-cart".
 */
export const GET_USECASE_COOCCURRENCES = {
  text: `MATCH (t:Tool)-[:SOLVES]->(u:UseCase)
WHERE u.name IN $names
MATCH (t)-[:SOLVES]->(other:UseCase)
WHERE NOT other.name IN $names
WITH other.name AS cooccurring, count(DISTINCT t) AS shared_tools
ORDER BY shared_tools DESC
LIMIT $limit
RETURN cooccurring, shared_tools`,
};

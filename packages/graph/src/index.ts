// @toolcairn/graph — Memgraph client, Cypher queries, repositories

// Client
export {
  closeMemgraphDriver,
  getMemgraphDriver,
  getMemgraphSession,
  memgraphHealthCheck,
  type HealthCheckResult,
} from './client.js';

// Queries
export {
  CREATE_TOOL,
  DELETE_TOOL,
  FIND_TOOL_BY_NAME,
  FIND_TOOLS_BY_CATEGORY,
  GET_DIRECT_EDGES_BETWEEN,
  GET_INTEGRATION_NEIGHBORS,
  GET_PAIRWISE_EDGES,
  GET_RELATED_TOOLS,
  GET_RUNTIME_CONSTRAINTS,
  GET_STACK_VERSION_EDGES,
  GET_STACK_VERSION_INFO,
  GET_TOOL_CO_OCCURRENCES,
  GET_TOOL_GRAPH_RERANK,
  GET_TOOL_NEIGHBORHOOD,
  GET_TOOL_USE_CASES,
  GET_VERSION_COMPATIBILITY_BETWEEN,
  LINK_TOOL_VERSION,
  MERGE_VERSION_NODE,
  TOOL_EXISTS,
  buildDecrementEdgeWeightQuery,
  buildIncrementEdgeWeightQuery,
  buildUpsertEdgeQuery,
  mapNeighborhoodRecords,
  mapRecordToToolNode,
  mapRecordToToolNodeWithScore,
  type CreateToolParams,
  type FindByCategoryParams,
  type FindByNameParams,
  type GetRelatedParams,
  type GetToolNeighborhoodParams,
  type LinkToolVersionParams,
  type PairwiseEdge,
  type ToolNeighborEdge,
  type ToolNeighborhood,
  type ToolUseCases,
  type UpsertEdgeParams,
  type UpsertVersionParams,
} from './queries/tool.queries.js';

// Repository interfaces
export type {
  DirectEdge,
  RepositoryError,
  RuntimeConstraintRow,
  StackEdgeRow,
  StackVersionInfo,
  StackVersionRow,
  ToolRepository,
  TopicNodeType,
  TopicNode,
  TopicEdgeParams,
  UpsertVersionEdgeParams,
  UpsertVersionNodeParams,
  UseCaseRepository,
  VersionCompatibilityRow,
} from './repositories/interfaces.js';

// Repository implementations
export { MemgraphToolRepository } from './repositories/tool.repository.js';
export { MemgraphUseCaseRepository } from './repositories/usecase.repository.js';

// Topology queries (for admin portal)
export {
  GET_EDGE_WEIGHT_SUMMARY,
  GET_GRAPH_TOPOLOGY,
  type EdgeWeightSummaryRow,
  type TopologyParams,
  type TopologyRow,
} from './queries/topology.queries.js';

// UseCase / topic node queries
export {
  FIND_TOOLS_BY_USE_CASES,
  FIND_TOOLS_BY_TOPIC_NODES,
  GET_ALL_USE_CASES,
  GET_USECASE_COOCCURRENCES,
  MERGE_TOPIC_NODE,
  UPSERT_SOLVES_EDGE,
  UPSERT_FOLLOWS_EDGE,
  UPSERT_BELONGS_TO_EDGE,
} from './queries/usecase.queries.js';

// In-memory fakes (for unit testing)
export { FakeToolRepository } from './test/fakes/tool.repository.fake.js';

// Version range evaluator (semver / pep440 / maven / composer / ruby / cargo / opaque)
export { satisfies, type SatisfiesResult } from './versioning/range-evaluator.js';

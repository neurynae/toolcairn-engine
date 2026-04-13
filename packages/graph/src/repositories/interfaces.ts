import type { GraphEdge, Result, ToolCategory, ToolNode } from '@toolcairn/core';
import type { PairwiseEdge, ToolNeighborhood, ToolUseCases } from '../queries/tool.queries.js';

export interface RepositoryError {
  code: string;
  message: string;
}

export interface DirectEdge {
  edgeType: string;
  weight: number;
  effective_weight: number;
  confidence: number;
  direction: 'a_to_b' | 'b_to_a';
}

export interface ToolRepository {
  createTool(tool: ToolNode): Promise<Result<ToolNode, RepositoryError>>;
  findByName(name: string): Promise<Result<ToolNode | null, RepositoryError>>;
  findByCategory(category: ToolCategory): Promise<Result<ToolNode[], RepositoryError>>;
  findByCategories(categories: ToolCategory[]): Promise<Result<ToolNode[], RepositoryError>>;
  findByTopics(topics: string[]): Promise<Result<ToolNode[], RepositoryError>>;
  upsertEdge(edge: GraphEdge): Promise<Result<void, RepositoryError>>;
  getRelated(toolName: string, depth?: number): Promise<Result<ToolNode[], RepositoryError>>;
  getToolNeighborhood(name: string): Promise<Result<ToolNeighborhood | null, RepositoryError>>;
  getDirectEdges(nameA: string, nameB: string): Promise<Result<DirectEdge[], RepositoryError>>;
  deleteTool(name: string): Promise<Result<void, RepositoryError>>;
  toolExists(name: string): Promise<Result<boolean, RepositoryError>>;
  getAllToolNames(): Promise<Result<string[], RepositoryError>>;
  findByUseCases(
    useCaseNames: string[],
    limit?: number,
  ): Promise<Result<ToolNode[], RepositoryError>>;
  findByGitHubUrl(urlFragment: string): Promise<Result<ToolNode | null, RepositoryError>>;
  getPairwiseEdges(names: string[]): Promise<Result<PairwiseEdge[], RepositoryError>>;
  getToolUseCases(names: string[]): Promise<Result<ToolUseCases[], RepositoryError>>;
}

export type TopicNodeType = 'UseCase' | 'Pattern' | 'Stack';

export interface TopicNode {
  name: string;
  description: string;
  node_type: TopicNodeType;
}

export interface TopicEdgeParams {
  tool_id: string;
  node_name: string;
  node_type: TopicNodeType;
  weight: number;
  confidence: number;
  last_verified: string;
  source: string;
  decay_rate: number;
}

export interface UseCaseRepository {
  mergeTopicNode(node: {
    id: string;
    name: string;
    description: string;
    node_type: TopicNodeType;
    created_at: string;
    updated_at: string;
  }): Promise<Result<void, RepositoryError>>;
  upsertTopicEdge(params: TopicEdgeParams): Promise<Result<void, RepositoryError>>;
  findToolsByUseCases(
    names: string[],
    limit?: number,
  ): Promise<Result<ToolNode[], RepositoryError>>;
  getAllUseCases(): Promise<
    Result<Array<{ name: string; description: string; tool_count: number }>, RepositoryError>
  >;
  findToolsByUseCasesScored(
    names: string[],
    limit?: number,
  ): Promise<Result<Array<{ tool: ToolNode; score: number }>, RepositoryError>>;
  getCooccurringUseCases(
    names: string[],
    limit?: number,
  ): Promise<Result<Array<{ name: string; count: number }>, RepositoryError>>;
}

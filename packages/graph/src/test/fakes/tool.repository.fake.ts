import type { GraphEdge, Result, ToolCategory, ToolNode } from '@toolcairn/core';
import type { PairwiseEdge, ToolNeighborhood, ToolUseCases } from '../../queries/tool.queries.js';
import type { DirectEdge, RepositoryError, ToolRepository } from '../../repositories/interfaces.js';

type ToolResult<T> = { ok: true; data: T } | { ok: false; error: RepositoryError };

/**
 * In-memory fake implementing ToolRepository for unit testing.
 * Does not require a Memgraph connection.
 */
export class FakeToolRepository implements ToolRepository {
  private tools: Map<string, ToolNode> = new Map();
  private edges: GraphEdge[] = [];

  async createTool(tool: ToolNode): Promise<ToolResult<ToolNode>> {
    try {
      this.tools.set(tool.name, tool);
      return { ok: true, data: tool };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'CREATE_FAILED', message } };
    }
  }

  async findByName(name: string): Promise<ToolResult<ToolNode | null>> {
    try {
      const tool = this.tools.get(name) ?? null;
      return { ok: true, data: tool };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async findByCategory(category: ToolCategory): Promise<ToolResult<ToolNode[]>> {
    try {
      const results = Array.from(this.tools.values()).filter((t) => t.category === category);
      return { ok: true, data: results };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async findByCategories(categories: ToolCategory[]): Promise<ToolResult<ToolNode[]>> {
    try {
      const results = Array.from(this.tools.values()).filter((t) =>
        (categories as string[]).includes(t.category),
      );
      return { ok: true, data: results };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async upsertEdge(edge: GraphEdge): Promise<ToolResult<void>> {
    try {
      const existingIndex = this.edges.findIndex(
        (e) =>
          e.source_id === edge.source_id && e.target_id === edge.target_id && e.type === edge.type,
      );
      if (existingIndex >= 0) {
        this.edges[existingIndex] = edge;
      } else {
        this.edges.push(edge);
      }
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async getRelated(toolName: string, _depth = 3): Promise<ToolResult<ToolNode[]>> {
    try {
      const tool = this.tools.get(toolName);
      if (!tool) {
        return { ok: true, data: [] };
      }
      const relatedNames = new Set<string>();
      for (const edge of this.edges) {
        if (edge.source_id === tool.id) {
          relatedNames.add(edge.target_id);
        } else if (edge.target_id === tool.id) {
          relatedNames.add(edge.source_id);
        }
      }
      const related = Array.from(relatedNames)
        .map((id) => Array.from(this.tools.values()).find((t) => t.id === id))
        .filter((t): t is ToolNode => t !== undefined);
      return { ok: true, data: related };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async getToolNeighborhood(
    _name: string,
  ): Promise<Result<ToolNeighborhood | null, RepositoryError>> {
    return { ok: true, data: null };
  }

  async deleteTool(name: string): Promise<ToolResult<void>> {
    try {
      this.tools.delete(name);
      return { ok: true, data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async toolExists(name: string): Promise<ToolResult<boolean>> {
    try {
      return { ok: true, data: this.tools.has(name) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  async getDirectEdges(
    _nameA: string,
    _nameB: string,
  ): Promise<Result<DirectEdge[], RepositoryError>> {
    return { ok: true, data: [] };
  }

  async findByUseCases(_useCaseNames: string[], _limit?: number): Promise<ToolResult<ToolNode[]>> {
    return { ok: true, data: [] };
  }

  async findByTopics(_topics: string[]): Promise<ToolResult<ToolNode[]>> {
    return { ok: true, data: [] };
  }

  async findByGitHubUrl(urlFragment: string): Promise<ToolResult<ToolNode | null>> {
    const found = Array.from(this.tools.values()).find((t) => t.github_url?.includes(urlFragment));
    return { ok: true, data: found ?? null };
  }

  async getPairwiseEdges(
    _names: string[],
  ): Promise<Result<PairwiseEdge[], RepositoryError>> {
    return { ok: true, data: [] };
  }

  async getToolUseCases(
    _names: string[],
  ): Promise<Result<ToolUseCases[], RepositoryError>> {
    return { ok: true, data: [] };
  }

  async getAllToolNames(): Promise<ToolResult<string[]>> {
    try {
      const names = Array.from(this.tools.keys());
      return { ok: true, data: names };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: 'DB_ERROR', message } };
    }
  }

  /** Reset all data - useful between test cases */
  clear(): void {
    this.tools.clear();
    this.edges = [];
  }

  /** Get all stored tools - useful for test assertions */
  getAllTools(): ToolNode[] {
    return Array.from(this.tools.values());
  }

  /** Get all stored edges - useful for test assertions */
  getAllEdges(): GraphEdge[] {
    return [...this.edges];
  }
}

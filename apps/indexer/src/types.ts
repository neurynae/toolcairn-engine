import type { ToolNode } from '@toolcairn/core';

export interface ExtractedToolData {
  name: string;
  display_name: string;
  description: string;
  github_url: string;
  homepage_url?: string;
  docs_url?: string;
  changelog_url?: string;
  owner_name?: string;
  owner_type?: 'User' | 'Organization';
  license: string;
  language: string;
  languages: string[];
  package_managers: Record<string, string>;
  deployment_models: string[];
}

export interface CrawlerResult {
  source: 'github' | 'npm' | 'pypi' | 'crates.io';
  url: string;
  raw: unknown;
  extracted: ExtractedToolData;
}

export interface TopicEdge {
  nodeType: 'UseCase' | 'Pattern' | 'Stack';
  nodeName: string;
  weight: number;
  confidence: number;
  source: string;
  decayRate: number;
}

export interface ProcessedTool {
  node: ToolNode;
  vector: number[];
  relationships: Array<{
    targetId: string;
    edgeType: string;
    weight: number;
    confidence: number;
    source: string;
    decayRate: number;
  }>;
  topicEdges: TopicEdge[];
}

export interface IndexJob {
  toolId: string;
  priority: number;
}

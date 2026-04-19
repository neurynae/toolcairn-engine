import type { PackageChannel, ToolNode, VersionMetadata } from '@toolcairn/core';

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
  is_fork?: boolean;
  license: string;
  language: string;
  languages: string[];
  package_managers: PackageChannel[];
  deployment_models: string[];
}

export interface CrawlerResult {
  source: 'github' | 'npm' | 'pypi' | 'crates.io';
  url: string;
  raw: unknown;
  extracted: ExtractedToolData;
  /**
   * Optional version metadata pulled from the registry response (or deps.dev).
   * When present, drives HAS_VERSION + VERSION_COMPATIBLE_WITH + REQUIRES_RUNTIME
   * edge writes. Absent for GitHub-source crawls or Tier C registries that
   * the crawler dispatcher hasn't probed.
   */
  versionMetadata?: VersionMetadata[];
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

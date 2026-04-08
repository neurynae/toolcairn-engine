import type { ToolNode } from '@toolcairn/core';

export type Dimension = 'topics' | 'deployment_model' | 'language' | 'license' | 'is_stable';

export const DIMENSIONS: Dimension[] = [
  'topics',
  'deployment_model',
  'language',
  'license',
  'is_stable',
];

export const IG_THRESHOLD = 0.1;

function entropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return counts.reduce((sum, count) => {
    if (count === 0) return sum;
    const p = count / total;
    return sum - p * Math.log2(p);
  }, 0);
}

function getDimensionValue(tool: ToolNode, dim: Dimension): string {
  switch (dim) {
    case 'topics': {
      const topics = tool.topics ?? [];
      // Fall back to category when topics not yet populated in Qdrant payload (transition state)
      return topics.length > 0
        ? (topics[0] ?? tool.category ?? 'other')
        : (tool.category ?? 'other');
    }
    case 'deployment_model':
      return tool.deployment_models[0] ?? 'unknown';
    case 'language':
      return tool.language;
    case 'license':
      return tool.license;
    case 'is_stable':
      return tool.health.maintenance_score >= 0.6 ? 'stable' : 'emerging';
  }
}

export class InformationGainCalculator {
  /**
   * Compute information gain for each dimension over the candidate set.
   * IG is measured as the entropy of the value distribution — a dimension
   * with evenly spread values splits the candidate set more effectively.
   */
  compute(candidates: ToolNode[]): Map<Dimension, number> {
    if (candidates.length === 0) return new Map();

    const gains: Array<[Dimension, number]> = DIMENSIONS.map((dim) => {
      const valueCounts = new Map<string, number>();
      for (const tool of candidates) {
        const val = getDimensionValue(tool, dim);
        valueCounts.set(val, (valueCounts.get(val) ?? 0) + 1);
      }
      return [dim, entropy([...valueCounts.values()])];
    });

    return new Map(gains.sort((a, b) => b[1] - a[1]));
  }
}

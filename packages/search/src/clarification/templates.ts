import type { ToolNode } from '@toolcairn/core';
import type { ClarificationQuestion } from '../types.js';
import type { Dimension } from './gain.js';

export interface ClarificationTemplate {
  dimension: Dimension;
  buildQuestion: (candidates: ToolNode[]) => ClarificationQuestion;
}

export function getClarificationTemplates(): ClarificationTemplate[] {
  return [
    {
      dimension: 'topics',
      buildQuestion: (tools) => ({
        dimension: 'topics',
        question: 'What type of tool are you looking for?',
        options: [
          ...new Set(
            tools.flatMap((t) =>
              t.topics && t.topics.length > 0 ? t.topics : [t.category ?? 'other'],
            ),
          ),
        ]
          .filter(Boolean)
          .sort()
          .slice(0, 8),
      }),
    },
    {
      dimension: 'deployment_model',
      buildQuestion: (tools) => ({
        dimension: 'deployment_model',
        question: 'How do you plan to deploy this tool?',
        options: [...new Set(tools.flatMap((t) => t.deployment_models))].sort(),
      }),
    },
    {
      dimension: 'language',
      buildQuestion: (tools) => ({
        dimension: 'language',
        question: 'What programming language is your project using?',
        options: [...new Set(tools.map((t) => t.language))].filter(Boolean).sort(),
      }),
    },
    {
      dimension: 'license',
      buildQuestion: (tools) => ({
        dimension: 'license',
        question: 'Do you have any license requirements?',
        options: [...new Set(tools.map((t) => t.license))].filter(Boolean).sort(),
      }),
    },
    {
      dimension: 'is_stable',
      buildQuestion: () => ({
        dimension: 'is_stable',
        question: 'Are you looking for a production-stable tool or open to newer emerging options?',
        options: ['stable', 'emerging'],
      }),
    },
  ];
}

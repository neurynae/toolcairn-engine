import type { ToolNode } from '@toolcairn/core';
import type { ClarificationQuestion } from '../types.js';
import type { Dimension } from './gain.js';

export interface ClarificationTemplate {
  dimension: Dimension;
  buildQuestion: (candidates: ToolNode[]) => ClarificationQuestion;
}

// Topics that describe language/platform/meta rather than the tool's purpose.
// These never help disambiguate "what kind of tool" the user wants.
const TOPIC_BLOCKLIST = new Set([
  'hacktoberfest',
  'awesome',
  'awesome-list',
  'open-source',
  'opensource',
  'software',
  'library',
  'framework',
  'tool',
  'tools',
  'utility',
  'linux',
  'macos',
  'windows',
  'cross-platform',
  'cli',
  'gui',
  'cpp',
  'python',
  'javascript',
  'typescript',
  'rust',
  'go',
  'java',
  'ruby',
  'php',
  'nodejs',
  'node',
  'other',
]);

function isUsefulTopic(topic: string): boolean {
  if (!topic) return false;
  const t = topic.trim().toLowerCase();
  if (t.length < 4) return false; // weed out '2d', 'acl', '3des', etc.
  if (TOPIC_BLOCKLIST.has(t)) return false;
  return true;
}

export function getClarificationTemplates(): ClarificationTemplate[] {
  return [
    {
      dimension: 'topics',
      buildQuestion: (tools) => {
        // Rank topics by how many candidate tools share them. Alphabetical
        // slicing produced garbage options like "2d, abac, acl, actix,
        // advanced-rag" — the user was never picking between those concepts.
        // Frequency ranking surfaces the terms that actually describe the
        // candidate pool, and the min-coverage filter drops long-tail tags
        // that only a single tool carries.
        const counts = new Map<string, number>();
        for (const t of tools) {
          const topics = t.topics && t.topics.length > 0 ? t.topics : [t.category ?? 'other'];
          const seen = new Set<string>();
          for (const raw of topics) {
            const topic = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
            if (!isUsefulTopic(topic) || seen.has(topic)) continue;
            seen.add(topic);
            counts.set(topic, (counts.get(topic) ?? 0) + 1);
          }
        }

        const minCoverage = Math.max(2, Math.floor(tools.length * 0.05));
        const options = [...counts.entries()]
          .filter(([, count]) => count >= minCoverage)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([topic]) => topic);

        return {
          dimension: 'topics',
          question: 'What kind of tool are you looking for?',
          options,
        };
      },
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

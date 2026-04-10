import type { ToolCategory } from '@toolcairn/core';
import pino from 'pino';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:refine-requirement' });

const PROPRIETARY_PRONE_CATEGORIES: ToolCategory[] = [
  'monitoring',
  'devops',
  'auth',
  'deployment',
  'analytics',
  'email',
  'payments',
  'notifications',
];

export function createRefineRequirementHandler(deps: Pick<ToolDeps, 'usecaseRepo'>) {
  return async function handleRefineRequirement(args: {
    prompt: string;
    classification: 'tool_discovery' | 'stack_building' | 'tool_comparison' | 'tool_configuration';
    project_context?: {
      existing_tools?: string[];
      language?: string;
      framework?: string;
    };
  }) {
    try {
      logger.info({ classification: args.classification }, 'refine_requirement called');

      const existingTools = args.project_context?.existing_tools ?? [];
      const language = args.project_context?.language ?? 'any';
      const framework = args.project_context?.framework;

      const useCasesResult = await deps.usecaseRepo.getAllUseCases();
      const availableUseCases = useCasesResult.ok ? useCasesResult.data : [];

      const categoryList =
        availableUseCases.length > 0
          ? availableUseCases
              .slice(0, 30)
              .map((u) => u.name)
              .join(', ')
          : 'web-framework, relational-database, auth, queue, cache, search, monitoring, testing';

      const projectContext =
        existingTools.length > 0
          ? `\nProject already uses: ${existingTools.join(', ')}. Do NOT suggest these.`
          : '';
      const languageContext = language !== 'any' ? `\nTarget language/runtime: ${language}.` : '';
      const frameworkContext = framework ? `\nExisting framework: ${framework}.` : '';

      const decomposition_prompt = `You are a software architect. Decompose this developer request into specific, independent tool requirements.

Developer request:
"""
${args.prompt}
"""
${projectContext}${languageContext}${frameworkContext}

For each distinct tool/library category needed, output a JSON object with:
- "need": precise technical description of the capability (e.g., "JWT authentication middleware", "CLI argument parser")
- "use_cases": array of 1-3 relevant tags from [${categoryList}]
- "constraints": object with: language (required if known), deployment_model (optional: self-hosted/cloud/serverless)
- "search_query": a precise, technical query (5-12 words) that captures what this tool does and how it is typically described in the ecosystem
- "why": one sentence on why this component is needed
- "is_likely_proprietary": true if this is commonly a paid/managed service (${PROPRIETARY_PRONE_CATEGORIES.join(', ')})

Output ONLY a valid JSON array. No explanation.`;

      const agent_instructions = [
        '## How to use refine_requirement output',
        '',
        '1. Send decomposition_prompt to yourself (the LLM) to get the JSON requirements array.',
        '',
        '2. For each requirement in the array:',
        '   - If is_likely_proprietary is false: call search_tools({ query: req.search_query, context: { filters: req.constraints } })',
        '   - If is_likely_proprietary is true: note it may not be in the index; suggest well-known services',
        '',
        '3. Pass constraints directly as search_tools context filters:',
        '   { filters: { language: req.constraints.language, deployment_model: req.constraints.deployment_model } }',
        '',
        '4. If classification is "stack_building": call get_stack after individual searches.',
        '',
        '5. Update .toolpilot/config.json with confirmed tools using update_project_config.',
      ].join('\n');

      return okResult({
        decomposition_prompt,
        available_use_cases: availableUseCases.slice(0, 30).map((u) => u.name),
        agent_instructions,
        classification: args.classification,
        next_tool: args.classification === 'stack_building' ? 'get_stack' : 'search_tools',
      });
    } catch (e) {
      logger.error({ err: e }, 'refine_requirement failed');
      return errResult('refine_error', e instanceof Error ? e.message : String(e));
    }
  };
}

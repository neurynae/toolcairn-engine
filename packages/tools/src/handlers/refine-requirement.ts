import type { ToolCategory } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:refine-requirement' });

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

      // Stack building needs a specialized prompt focused on tool-description vocabulary
      // so get_stack sub_needs match how tools describe themselves, not how users describe their needs.
      const isStackBuilding = args.classification === 'stack_building';

      const decomposition_prompt = isStackBuilding
        ? `You are a software architect decomposing a project into its distinct tool layers for stack discovery.

Developer request:
"""
${args.prompt}
"""
${projectContext}${languageContext}${frameworkContext}

For each distinct functional layer, output a JSON object with:
- "need": the specific technical role this layer fills
- "tool_category": the precise technical category name used in this ecosystem (specific noun phrase, not "platform", "solution", or "system")
- "use_cases": array of 1-3 relevant tags from [${categoryList}]
- "constraints": object with: language (if known), deployment_model (self-hosted/cloud/serverless)
- "search_query": 5-10 words describing this tool as it describes itself in its own documentation. Use the tool_category + ecosystem + primary technical characteristics. Never name specific tools or use generic words like "open source", "platform", "service", "solution".
- "why": one sentence on why this layer is needed
- "is_likely_proprietary": true if this is commonly a paid/managed service (${PROPRIETARY_PRONE_CATEGORIES.join(', ')})

Output ONLY a valid JSON array. No explanation.`
        : `You are a software architect. Decompose this developer request into specific, independent tool requirements.

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

      const agent_instructions = isStackBuilding
        ? [
            '## How to use refine_requirement output for stack_building',
            '',
            '1. Send decomposition_prompt to yourself (the LLM) to get the JSON requirements array.',
            '',
            '2. Call get_stack with:',
            '   - use_case: the original developer request',
            '   - sub_needs: combine tool_category + search_query for each requirement into a single precise query per layer',
            '     The tool_category anchors the search to the right tool type; the search_query adds ecosystem and function context.',
            '',
            '3. For proprietary layers (is_likely_proprietary: true): note them separately — they may not be in the index.',
            '',
            '4. Update .toolpilot/config.json with confirmed tools using update_project_config.',
          ].join('\n')
        : [
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
            '4. Update .toolpilot/config.json with confirmed tools using update_project_config.',
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

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

      logger.debug(
        { useCaseCount: availableUseCases.length, ok: useCasesResult.ok },
        'Loaded use cases from graph',
      );

      const categoryList =
        availableUseCases.length > 0
          ? availableUseCases
              .slice(0, 30)
              .map((u) => u.name)
              .join(', ')
          : 'web-framework, relational-database, auth, queue, cache, search, monitoring, testing';

      const projectContext =
        existingTools.length > 0
          ? `\nProject already uses: ${existingTools.join(', ')}. Do NOT suggest these as new requirements.`
          : '';
      const languageContext = language !== 'any' ? `\nTarget language/runtime: ${language}.` : '';
      const frameworkContext = framework ? `\nExisting framework: ${framework}.` : '';

      const decomposition_prompt = `You are a software architect. Analyze this developer request and decompose it into specific, independent tool requirements.

Developer request:
"""
${args.prompt}
"""
${projectContext}${languageContext}${frameworkContext}

For each distinct tool/service/library category needed, output a JSON object with:
- "need": short description of what is needed (e.g., "authentication system", "full-text search")
- "use_cases": array of relevant tags from [${categoryList}]
- "constraints": object with optional keys: language, deployment_model (self-hosted/cloud/embedded/serverless), license (open-source/commercial)
- "search_query": a focused search query string to find the right tool (5-15 words)
- "why": one sentence explaining why this component is needed
- "is_likely_proprietary": true if this component often uses paid/closed-source services (common for: ${PROPRIETARY_PRONE_CATEGORIES.join(', ')})

Output a valid JSON array of these objects. Output ONLY the JSON array, no explanation.`;

      const agent_instructions = [
        '1. Send decomposition_prompt to the LLM and parse the JSON array response.',
        '2. For each requirement where is_likely_proprietary is false, call search_tools with the search_query.',
        '3. For each requirement where is_likely_proprietary is true, note that these may not be in the ToolPilot index.',
        '4. After all searches complete, call get_stack if classification is "stack_building" for a bundled recommendation.',
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

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

      /**
       * CRITICAL INSTRUCTION FOR SEARCH QUALITY:
       *
       * The search system uses semantic vector embeddings, not keyword matching.
       * search_query must be written in "tool capability language" — the vocabulary
       * tools use to describe THEMSELVES in their README/description — not in
       * "user intent language" (what the user wants to do).
       *
       * BAD search_query: "add authentication to my Next.js app"
       *   (user intent — no tool describes itself this way)
       *
       * GOOD search_query: "Next.js authentication session management JWT OAuth middleware"
       *   (capability language — matches how auth libraries describe themselves)
       *
       * BAD search_query: "build CLI tool in Node.js"
       *   (intent — will match Node.js runtime itself, not CLI frameworks)
       *
       * GOOD search_query: "Node.js CLI framework argument parsing command builder"
       *   (capability — matches how commander/yargs describe themselves)
       *
       * The semantic vector will find tools whose DESCRIPTIONS match the query meaning.
       * Use technical nouns and capability verbs, not user intent phrases.
       */
      const decomposition_prompt = `You are a software architect decomposing a developer request into specific tool requirements for a semantic vector search system.

Developer request:
"""
${args.prompt}
"""
${projectContext}${languageContext}${frameworkContext}

CRITICAL: The search uses semantic vector embeddings. Each search_query must use "tool capability language" — the vocabulary tools use to describe themselves — NOT user intent language.

Examples of the difference:
- User says "add auth to Next.js" → search_query: "Next.js authentication session JWT OAuth library middleware"
- User says "build CLI tool" → search_query: "Node.js CLI framework command argument parsing terminal"
- User says "validate data" → search_query: "TypeScript schema validation runtime type inference library"

For each distinct tool/library needed, output a JSON object with:
- "need": short description of the capability needed (e.g., "CLI argument parser", "JWT authentication library")
- "use_cases": array of 1-3 relevant tags from [${categoryList}]
- "constraints": object with: language (required), deployment_model (optional: self-hosted/cloud/serverless)
- "search_query": 5-12 word query in capability language describing what the tool DOES, not what the user wants
- "why": one sentence explaining why this specific library/tool category is needed
- "is_likely_proprietary": true if this is commonly a paid/managed service (${PROPRIETARY_PRONE_CATEGORIES.join(', ')})

Output ONLY a valid JSON array. No explanation text.`;

      const agent_instructions = [
        '## How to use refine_requirement output',
        '',
        '1. Send decomposition_prompt to yourself (the LLM) to get the JSON requirements array.',
        '   The LLM decomposition transforms user intent into tool capability language.',
        '',
        '2. For each requirement in the array:',
        '   - If is_likely_proprietary is false: call search_tools({ query: req.search_query, context: { filters: req.constraints } })',
        '   - If is_likely_proprietary is true: note it may not be in the index; suggest well-known services',
        '',
        '3. Pass the constraints directly as search_tools context filters:',
        '   { filters: { language: req.constraints.language, deployment_model: req.constraints.deployment_model } }',
        '',
        '4. If classification is "stack_building": call get_stack after individual searches for a bundled recommendation.',
        '',
        '5. The search_query is already in the correct format for semantic vector search — use it as-is.',
        '   Do NOT rephrase it back into user intent language.',
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

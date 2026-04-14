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

      const decomposition_prompt = `You are a software architect. Decompose this developer request into specific, independent tool requirements.

Developer request:
"""
${args.prompt}
"""
${projectContext}${languageContext}${frameworkContext}

For each distinct tool/library category needed, output a JSON object with:
- "need": precise technical description of the capability (e.g., "JWT authentication middleware", "CLI argument parser"). Be specific about the tool's domain — say "Express.js HTTP web framework for Node.js" not just "web framework".
- "use_cases": array of 1-3 relevant tags from [${categoryList}]
- "constraints": object with: language (required if known), deployment_model (optional: self-hosted/cloud/serverless)
- "search_query": a precise, domain-specific query (5-12 words) for searching a tool index. CRITICAL rules:
  * Include the specific technology domain (e.g. "Ethereum Solidity smart contract development toolkit" not "blockchain development toolkit")
  * Include the well-known tool name if there is a canonical tool for this need (e.g. "Hardhat Ethereum smart contract testing framework" not just "smart contract framework")
  * Avoid generic adjectives like "open source", "lightweight", "modern", "best" — they match everything
  * Avoid generic nouns that span domains like "platform", "system", "tool", "service" without a domain qualifier
  * Good examples: "Playwright end-to-end browser automation testing", "commander.js Node.js CLI argument parser", "Hardhat Ethereum development environment"
  * Bad examples: "open source platform for testing", "CLI tool for argument parsing", "development environment"
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
        '4. If classification is "stack_building": call get_stack with sub_needs = the search_query values from the JSON array.',
        '   Example: get_stack({ use_case: "...", sub_needs: ["Hardhat Ethereum smart contract testing", "OpenZeppelin Solidity security library", ...] })',
        '   This gives get_stack one precise search query per stack layer for best accuracy.',
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

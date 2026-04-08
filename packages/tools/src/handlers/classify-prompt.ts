import pino from 'pino';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:classify-prompt' });

// Categories a prompt can fall into
export type PromptClassification =
  | 'tool_discovery' // needs to find/select tools or libraries
  | 'stack_building' // needs to compose multiple tools into a stack
  | 'tool_configuration' // already has a tool, needs setup/config help
  | 'tool_comparison' // wants to compare two or more tools
  | 'debugging' // hitting an error or unexpected behavior
  | 'general_coding'; // architecture, business logic, no tool selection needed

// Categories where ToolPilot search is useful
const TOOL_REQUIRED_CLASSIFICATIONS: PromptClassification[] = [
  'tool_discovery',
  'stack_building',
  'tool_comparison',
];

export async function handleClassifyPrompt(args: {
  prompt: string;
  project_tools?: string[];
}) {
  try {
    logger.info({ promptLen: args.prompt.length }, 'classify_prompt called');

    const projectToolsContext =
      args.project_tools && args.project_tools.length > 0
        ? `\n\nThe project already uses: ${args.project_tools.join(', ')}. Consider whether the prompt relates to tools already confirmed in the project.`
        : '';

    // Build a structured prompt the agent uses to classify
    const classification_prompt = `Classify the following developer prompt into exactly ONE of these categories:

Categories:
- tool_discovery: The developer needs to find, select, or identify a tool, library, framework, or service
- stack_building: The developer needs to compose multiple tools together to build a complete system
- tool_comparison: The developer wants to compare two or more specific tools
- tool_configuration: The developer already has a tool chosen and needs help configuring or using it
- debugging: The developer is encountering an error, bug, or unexpected behavior
- general_coding: Architecture, business logic, algorithms — no new tool selection is needed

Rules:
1. If the prompt involves building something "from scratch" or asks for tech stack recommendations, classify as stack_building
2. If the prompt mentions a specific tool and asks "should I use X or Y", classify as tool_comparison
3. If the prompt is about implementing features WITHOUT mentioning specific tools, classify as tool_discovery
4. If the prompt mentions an error message, traceback, or "not working", classify as debugging
5. Respond with ONLY the category name, nothing else

Prompt to classify:
"""
${args.prompt}
"""${projectToolsContext}

Your response (one category name only):`;

    const needs_tool_search_prompt = `Based on this classification, determine if ToolPilot tool search should be invoked.
Respond with 1 if the classification is one of: tool_discovery, stack_building, tool_comparison
Respond with 0 if the classification is: tool_configuration, debugging, general_coding
Respond with ONLY 0 or 1.`;

    return okResult({
      classification_prompt,
      needs_tool_search_prompt,
      valid_classifications: [
        'tool_discovery',
        'stack_building',
        'tool_comparison',
        'tool_configuration',
        'debugging',
        'general_coding',
      ] as PromptClassification[],
      tool_required_if: TOOL_REQUIRED_CLASSIFICATIONS,
      instructions:
        'Step 1: Send classification_prompt to the LLM and get a classification. Step 2: If classification is in tool_required_if, call refine_requirement with the classification. Otherwise, proceed without ToolPilot search.',
    });
  } catch (e) {
    logger.error({ err: e }, 'classify_prompt failed');
    return errResult('classify_error', e instanceof Error ? e.message : String(e));
  }
}

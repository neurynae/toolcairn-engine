import { z } from 'zod';

export const searchToolsSchema = {
  query: z.string().min(1).max(500),
  context: z.object({ filters: z.record(z.string(), z.unknown()) }).optional(),
  query_id: z.string().uuid().optional(),
  user_id: z.string().optional(),
};

export const searchToolsRespondSchema = {
  query_id: z.string().uuid(),
  answers: z.array(z.object({ dimension: z.string(), value: z.string() })),
};

export const reportOutcomeSchema = {
  query_id: z.string().uuid(),
  chosen_tool: z.string(),
  reason: z.string().optional(),
  outcome: z.enum(['success', 'failure', 'replaced', 'pending']),
  feedback: z.string().optional(),
  replaced_by: z.string().optional(),
};

export const getStackSchema = {
  use_case: z.string().min(1),
  constraints: z
    .object({
      deployment_model: z.enum(['self-hosted', 'cloud', 'embedded', 'serverless']).optional(),
      language: z.string().optional(),
      license: z.string().optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(10).default(5),
};

export const checkIssueSchema = {
  tool_name: z.string(),
  issue_title: z.string(),
  retry_count: z.number().int().min(0).default(0),
  docs_consulted: z.boolean().default(false),
  issue_url: z.string().url().optional(),
};

export const checkCompatibilitySchema = {
  tool_a: z.string(),
  tool_b: z.string(),
};

export const suggestGraphUpdateSchema = {
  suggestion_type: z.enum(['new_tool', 'new_edge', 'update_health', 'new_use_case']),
  data: z.object({
    tool_name: z.string().optional(),
    github_url: z.string().url().optional(),
    description: z.string().optional(),
    relationship: z
      .object({
        source_tool: z.string(),
        target_tool: z.string(),
        edge_type: z.enum([
          'SOLVES',
          'REQUIRES',
          'INTEGRATES_WITH',
          'REPLACES',
          'CONFLICTS_WITH',
          'POPULAR_WITH',
          'BREAKS_FROM',
          'COMPATIBLE_WITH',
        ]),
        evidence: z.string().optional(),
      })
      .optional(),
    use_case: z
      .object({
        name: z.string(),
        description: z.string(),
        tools: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  query_id: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
};

export const compareToolsSchema = {
  tool_a: z.string().min(1),
  tool_b: z.string().min(1),
  use_case: z.string().optional(),
  project_config: z.string().max(100_000).optional(),
};

export const toolpilotInitSchema = {
  agent: z.enum(['claude', 'cursor', 'windsurf', 'copilot', 'copilot-cli', 'opencode', 'generic']),
  project_root: z.string().min(1),
  server_path: z.string().optional(),
  detected_files: z.array(z.string()).optional(),
};

export const initProjectConfigSchema = {
  project_name: z.string().min(1).max(200),
  language: z.string().min(1).max(50),
  framework: z.string().optional(),
  detected_tools: z
    .array(
      z.object({
        name: z.string(),
        source: z.enum(['toolpilot', 'manual', 'non_oss']),
        version: z.string().optional(),
      }),
    )
    .optional(),
};

export const readProjectConfigSchema = {
  config_content: z.string().min(1).max(100_000),
};

export const updateProjectConfigSchema = {
  current_config: z.string().min(1).max(100_000),
  action: z.enum(['add_tool', 'remove_tool', 'update_tool', 'add_evaluation']),
  tool_name: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
};

export const classifyPromptSchema = {
  prompt: z.string().min(1).max(2000),
  project_tools: z.array(z.string()).optional(),
};

export const verifySuggestionSchema = {
  query: z.string().min(1).max(500),
  agent_suggestions: z.array(z.string().min(1)).min(1).max(10),
};

export const refineRequirementSchema = {
  prompt: z.string().min(1).max(2000),
  classification: z.enum([
    'tool_discovery',
    'stack_building',
    'tool_comparison',
    'tool_configuration',
  ]),
  project_context: z
    .object({
      existing_tools: z.array(z.string()).optional(),
      language: z.string().optional(),
      framework: z.string().optional(),
    })
    .optional(),
};

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
  user_id: z.string().uuid().optional(),
};

export const getStackSchema = {
  use_case: z.string().min(1),
  sub_needs: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          sub_need_type: z
            .string()
            .min(1)
            .max(50)
            .describe('Stack layer type, e.g. "database", "auth", "web-framework"'),
          keyword_sentence: z
            .string()
            .min(1)
            .max(500)
            .describe('Comma-separated keywords matching tool vocabulary, max 20 keywords'),
        }),
      ]),
    )
    .min(1)
    .max(8)
    .optional()
    .describe(
      'Structured sub-needs from refine_requirement. Each is {sub_need_type, keyword_sentence} for keyword-matched search, or a plain string (legacy). The structured format dramatically improves accuracy.',
    ),
  constraints: z
    .object({
      deployment_model: z.enum(['self-hosted', 'cloud', 'embedded', 'serverless']).optional(),
      language: z.string().optional(),
      license: z.string().optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(10).default(5),
};

export const batchResolveSchema = {
  /** Request version — allows the server to evolve response shape without breaking old clients. */
  api_version: z.enum(['1']).default('1'),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        ecosystem: z.enum([
          'npm',
          'pypi',
          'cargo',
          'go',
          'rubygems',
          'maven',
          'gradle',
          'composer',
          'hex',
          'pub',
          'nuget',
          'swift-pm',
        ]),
        /**
         * Canonical package name as declared in the INSTALLED package's own
         * manifest (e.g. node_modules/<dep-key>/package.json#name).
         * Handles npm aliased installs where the dep key differs from the
         * true package name. When present, this takes precedence over `name`
         * for the registry-key lookup.
         */
        canonical_package_name: z.string().min(1).max(200).optional(),
        /**
         * Repository URL extracted from the installed package's manifest
         * (normalised: https, no trailing .git). Primary disambiguator —
         * lets the resolver bypass registry-key gaps and name collisions
         * entirely when the client supplies a trustworthy URL.
         */
        github_url: z
          .string()
          .min(1)
          .max(500)
          .refine((s) => s.startsWith('http://') || s.startsWith('https://'), {
            message: 'github_url must be an http(s) URL',
          })
          .optional(),
      }),
    )
    .min(1)
    .max(500),
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
  tool_a_version: z
    .string()
    .optional()
    .describe('Specific version of tool_a to evaluate (e.g., "14.0.0"). Default: latest.'),
  tool_b_version: z
    .string()
    .optional()
    .describe('Specific version of tool_b to evaluate (e.g., "18.2.0"). Default: latest.'),
};

export const suggestGraphUpdateSchema = {
  suggestion_type: z.enum(['new_tool', 'new_edge', 'update_health', 'new_use_case']),
  data: z.object({
    // Single-tool shape (backward compatible)
    tool_name: z.string().optional(),
    github_url: z.string().url().optional(),
    description: z.string().optional(),
    // Batch shape — used when the MCP agent drains `unknown_tools[]` from
    // toolcairn_init's post-auth provisioning. Applies to suggestion_type='new_tool'.
    tools: z
      .array(
        z.object({
          tool_name: z.string().min(1),
          github_url: z.string().url().optional(),
          description: z.string().optional(),
        }),
      )
      .min(1)
      .max(200)
      .optional(),
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
          'HAS_VERSION',
          'VERSION_COMPATIBLE_WITH',
          'REQUIRES_RUNTIME',
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

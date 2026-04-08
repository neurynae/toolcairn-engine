import type { ConfirmedTool, ToolPilotProjectConfig, ToolSource } from '@toolcairn/core';
import pino from 'pino';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:init-project-config' });

export async function handleInitProjectConfig(args: {
  project_name: string;
  language: string;
  framework?: string;
  detected_tools?: Array<{
    name: string;
    source: ToolSource;
    version?: string;
  }>;
}) {
  try {
    logger.info({ project: args.project_name }, 'init_project_config called');

    const now = new Date().toISOString();

    const confirmedTools: ConfirmedTool[] = (args.detected_tools ?? []).map((t) => ({
      name: t.name,
      source: t.source,
      version: t.version,
      chosen_at: now,
      chosen_reason: 'Auto-detected from project files during toolpilot_init',
      alternatives_considered: [],
    }));

    const config: ToolPilotProjectConfig = {
      version: '1.0',
      project: {
        name: args.project_name,
        language: args.language,
        framework: args.framework,
      },
      tools: {
        confirmed: confirmedTools,
        pending_evaluation: [],
      },
      audit_log: [
        {
          action: 'init',
          tool: '__project__',
          timestamp: now,
          reason: `Project config initialized for ${args.project_name}`,
        },
      ],
    };

    const config_json = JSON.stringify(config, null, 2);

    return okResult({
      config_json,
      file_path: '.toolpilot/config.json',
      instructions:
        'Create the directory .toolpilot/ in your project root (if it does not exist), then write this config_json content to .toolpilot/config.json. Also add .toolpilot/ to .gitignore if not already present.',
      confirmed_count: confirmedTools.length,
      next_step:
        confirmedTools.length > 0
          ? 'Config initialized with auto-detected tools. Use search_tools to find any additional tools you need.'
          : 'Config initialized. Use classify_prompt → refine_requirement → search_tools to discover tools for your project.',
    });
  } catch (e) {
    logger.error({ err: e }, 'init_project_config failed');
    return errResult('init_config_error', e instanceof Error ? e.message : String(e));
  }
}

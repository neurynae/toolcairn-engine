import type {
  ConfirmedTool,
  PendingTool,
  ToolPilotProjectConfig,
  ToolSource,
} from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:update-project-config' });

type UpdateAction = 'add_tool' | 'remove_tool' | 'update_tool' | 'add_evaluation';

export async function handleUpdateProjectConfig(args: {
  current_config: string;
  action: UpdateAction;
  tool_name: string;
  data?: Record<string, unknown>;
}) {
  try {
    logger.info({ action: args.action, tool: args.tool_name }, 'update_project_config called');

    let config: ToolPilotProjectConfig;
    try {
      config = JSON.parse(args.current_config) as ToolPilotProjectConfig;
    } catch {
      return errResult('parse_error', 'current_config is not valid JSON');
    }

    const now = new Date().toISOString();
    const data = args.data ?? {};

    switch (args.action) {
      case 'add_tool': {
        // Remove from pending if present
        config.tools.pending_evaluation = config.tools.pending_evaluation.filter(
          (t) => t.name !== args.tool_name,
        );

        // Avoid duplicates
        if (!config.tools.confirmed.some((t) => t.name === args.tool_name)) {
          const newTool: ConfirmedTool = {
            name: args.tool_name,
            source: (data.source as ToolSource) ?? 'toolpilot',
            github_url: data.github_url as string | undefined,
            version: data.version as string | undefined,
            chosen_at: now,
            chosen_reason: (data.chosen_reason as string) ?? 'Selected via ToolPilot',
            alternatives_considered: (data.alternatives_considered as string[]) ?? [],
            query_id: data.query_id as string | undefined,
            notes: data.notes as string | undefined,
          };
          config.tools.confirmed.push(newTool);
        }

        config.audit_log.push({
          action: 'add_tool',
          tool: args.tool_name,
          timestamp: now,
          reason: (data.chosen_reason as string) ?? 'Added via ToolPilot recommendation',
        });
        break;
      }

      case 'remove_tool': {
        config.tools.confirmed = config.tools.confirmed.filter((t) => t.name !== args.tool_name);
        config.tools.pending_evaluation = config.tools.pending_evaluation.filter(
          (t) => t.name !== args.tool_name,
        );
        config.audit_log.push({
          action: 'remove_tool',
          tool: args.tool_name,
          timestamp: now,
          reason: (data.reason as string) ?? 'Removed from project',
        });
        break;
      }

      case 'update_tool': {
        const idx = config.tools.confirmed.findIndex((t) => t.name === args.tool_name);
        if (idx === -1) {
          return errResult('not_found', `Tool "${args.tool_name}" not found in confirmed tools`);
        }
        const existing = config.tools.confirmed[idx];
        if (!existing) {
          return errResult('not_found', `Tool "${args.tool_name}" not found`);
        }
        config.tools.confirmed[idx] = {
          ...existing,
          ...(data.version !== undefined ? { version: data.version as string } : {}),
          ...(data.notes !== undefined ? { notes: data.notes as string } : {}),
          ...(data.chosen_reason !== undefined
            ? { chosen_reason: data.chosen_reason as string }
            : {}),
          ...(data.alternatives_considered !== undefined
            ? { alternatives_considered: data.alternatives_considered as string[] }
            : {}),
        };
        config.audit_log.push({
          action: 'update_tool',
          tool: args.tool_name,
          timestamp: now,
          reason: (data.reason as string) ?? 'Tool details updated',
        });
        break;
      }

      case 'add_evaluation': {
        if (
          !config.tools.pending_evaluation.some((t) => t.name === args.tool_name) &&
          !config.tools.confirmed.some((t) => t.name === args.tool_name)
        ) {
          const pending: PendingTool = {
            name: args.tool_name,
            category: (data.category as string) ?? 'other',
            added_at: now,
          };
          config.tools.pending_evaluation.push(pending);
        }
        config.audit_log.push({
          action: 'add_evaluation',
          tool: args.tool_name,
          timestamp: now,
          reason: (data.reason as string) ?? 'Added for evaluation',
        });
        break;
      }
    }

    const updated_config_json = JSON.stringify(config, null, 2);

    return okResult({
      updated_config_json,
      file_path: '.toolpilot/config.json',
      action_applied: args.action,
      tool_name: args.tool_name,
      confirmed_count: config.tools.confirmed.length,
      pending_count: config.tools.pending_evaluation.length,
      instructions: 'Write updated_config_json to .toolpilot/config.json to persist this change.',
    });
  } catch (e) {
    logger.error({ err: e }, 'update_project_config failed');
    return errResult('update_config_error', e instanceof Error ? e.message : String(e));
  }
}

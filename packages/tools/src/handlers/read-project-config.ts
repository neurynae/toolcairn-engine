import type { ToolPilotProjectConfig } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { errResult, okResult } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:read-project-config' });

// Tools older than this many days will be flagged for re-evaluation
const STALENESS_THRESHOLD_DAYS = 90;

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

export async function handleReadProjectConfig(args: { config_content: string }) {
  try {
    logger.info('read_project_config called');

    let config: ToolPilotProjectConfig;
    try {
      config = JSON.parse(args.config_content) as ToolPilotProjectConfig;
    } catch {
      return errResult('parse_error', 'config_content is not valid JSON');
    }

    if (config.version !== '1.0') {
      return errResult('version_error', `Unsupported config version: ${config.version}`);
    }

    const confirmedToolNames = config.tools.confirmed.map((t) => t.name);
    const pendingToolNames = config.tools.pending_evaluation.map((t) => t.name);

    // Flag tools that may need re-evaluation due to age.
    // Use last_verified (most recent check) > chosen_at > confirmed_at (legacy alias).
    const staleTools = config.tools.confirmed
      .filter((t) => {
        const date = t.last_verified ?? t.chosen_at ?? t.confirmed_at;
        return date ? daysSince(date) > STALENESS_THRESHOLD_DAYS : true;
      })
      .map((t) => {
        const date = t.last_verified ?? t.chosen_at ?? t.confirmed_at;
        const days = date ? Math.round(daysSince(date)) : -1;
        return {
          name: t.name,
          last_verified: date ?? 'unknown',
          days_since_verified: days,
          recommendation: 'Consider using check_issue to verify no new known issues',
        };
      });

    // Tools from non_oss sources for special handling guidance
    const non_oss_tools = config.tools.confirmed
      .filter((t) => t.source === 'non_oss')
      .map((t) => t.name);

    const toolpilot_indexed_tools = config.tools.confirmed
      .filter((t) => t.source === 'toolpilot')
      .map((t) => t.name);

    return okResult({
      project: config.project,
      confirmed_tools: confirmedToolNames,
      pending_tools: pendingToolNames,
      non_oss_tools,
      toolpilot_indexed_tools,
      stale_tools: staleTools,
      total_confirmed: confirmedToolNames.length,
      total_pending: pendingToolNames.length,
      last_audit_entry: config.audit_log.at(-1) ?? null,
      agent_instructions: [
        `Project: ${config.project.name} (${config.project.language}${config.project.framework ? `, ${config.project.framework}` : ''})`,
        `Already confirmed tools: ${confirmedToolNames.join(', ') || 'none'}`,
        'When recommending tools, skip any already in confirmed_tools.',
        non_oss_tools.length > 0
          ? `Non-OSS tools in project (handle separately): ${non_oss_tools.join(', ')}`
          : '',
        staleTools.length > 0
          ? `These tools may be stale and worth re-checking: ${staleTools.map((t) => t.name).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  } catch (e) {
    logger.error({ err: e }, 'read_project_config failed');
    return errResult('read_config_error', e instanceof Error ? e.message : String(e));
  }
}

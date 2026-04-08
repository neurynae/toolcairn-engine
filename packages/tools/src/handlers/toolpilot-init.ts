import pino from 'pino';
import {
  type AgentType,
  getInstructionsForAgent,
  getMcpConfigEntry,
  getOpenCodeMcpEntry,
} from '../templates/agent-instructions.js';
import { generateTrackerHtml } from '../templates/generate-tracker.js';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:toolpilot-init' });

export async function handleToolpilotInit(args: {
  agent: AgentType;
  project_root: string;
  server_path?: string;
  detected_files?: string[];
}) {
  try {
    logger.info({ agent: args.agent, project_root: args.project_root }, 'toolpilot_init called');

    const instructions = getInstructionsForAgent(args.agent);
    const isOpenCode = args.agent === 'opencode';
    const mcpConfigEntry = isOpenCode
      ? getOpenCodeMcpEntry(args.server_path)
      : getMcpConfigEntry(args.server_path);
    const mcpConfigFile = isOpenCode ? 'opencode.json' : '.mcp.json';

    const hasMcpJson = args.detected_files?.some(
      (f) => f === mcpConfigFile || f.endsWith(`/${mcpConfigFile}`),
    );
    const hasInstructionFile = args.detected_files?.some((f) => f.endsWith(instructions.file_path));
    const hasToolpilotConfig = args.detected_files?.some((f) =>
      f.includes('.toolpilot/config.json'),
    );
    const hasTrackerHtml = args.detected_files?.some((f) => f.includes('.toolpilot/tracker.html'));

    const eventsPath = `${args.project_root}/.toolpilot/events.jsonl`;

    const setupSteps: Array<{
      step: number;
      action: string;
      file: string;
      content?: string;
      note?: string;
    }> = [];

    let step = 1;

    setupSteps.push({
      step: step++,
      action: hasInstructionFile ? 'append' : 'create',
      file: instructions.file_path,
      content: instructions.content,
      note: hasInstructionFile
        ? `Append the content to your existing ${instructions.file_path}`
        : `Create ${instructions.file_path} with the content`,
    });

    const mcpContent = isOpenCode
      ? JSON.stringify({ mcp: mcpConfigEntry }, null, 2)
      : JSON.stringify({ mcpServers: mcpConfigEntry }, null, 2);
    const mcpMergeNote = isOpenCode
      ? `Merge the toolpilot entry into your existing ${mcpConfigFile} under "mcp"`
      : `Merge the toolpilot entry into your existing ${mcpConfigFile} under "mcpServers"`;
    const mcpCreateNote = isOpenCode
      ? `Create ${mcpConfigFile} with this content (OpenCode MCP config format)`
      : `Create ${mcpConfigFile} with this content`;
    setupSteps.push({
      step: step++,
      action: hasMcpJson ? 'merge' : 'create',
      file: mcpConfigFile,
      content: mcpContent,
      note: hasMcpJson ? mcpMergeNote : mcpCreateNote,
    });

    if (!hasToolpilotConfig) {
      setupSteps.push({
        step: step++,
        action: 'create',
        file: '.toolpilot/config.json',
        note: 'Call init_project_config to generate the config content, then write to .toolpilot/config.json',
      });
    }

    if (!hasTrackerHtml) {
      setupSteps.push({
        step: step++,
        action: 'create',
        file: '.toolpilot/tracker.html',
        content: generateTrackerHtml(eventsPath),
        note: `Open .toolpilot/tracker.html in your browser to monitor MCP tool calls in real time. Set TOOLPILOT_EVENTS_PATH=${eventsPath} in your MCP server environment to enable event logging.`,
      });
    }

    setupSteps.push({
      step: step++,
      action: 'append',
      file: '.gitignore',
      content: '\n# ToolPilot\n.toolpilot/events.jsonl\n',
      note: 'Add .toolpilot/events.jsonl to .gitignore (the tracker event log)',
    });

    const agentFileLabel: Record<AgentType, string> = {
      claude: 'CLAUDE.md',
      cursor: '.cursorrules',
      windsurf: '.windsurfrules',
      copilot: '.github/copilot-instructions.md',
      'copilot-cli': '.github/copilot-instructions.md',
      opencode: 'AGENTS.md',
      generic: 'AI_INSTRUCTIONS.md',
    };

    return okResult({
      agent: args.agent,
      instruction_file: agentFileLabel[args.agent],
      setup_steps: setupSteps,
      mcp_config_entry: mcpConfigEntry,
      events_path: eventsPath,
      summary: [
        `ToolPilot setup for ${args.agent} agent in ${args.project_root}`,
        `Instructions will be added to: ${instructions.file_path}`,
        `MCP server entry: toolpilot → ${mcpConfigFile}`,
        hasToolpilotConfig
          ? '.toolpilot/config.json already exists — skipping init'
          : 'Run init_project_config next to generate .toolpilot/config.json',
        hasTrackerHtml
          ? '.toolpilot/tracker.html already exists — skipping'
          : 'Tracker dashboard: open .toolpilot/tracker.html in browser',
      ].join('\n'),
      next_steps: hasToolpilotConfig
        ? 'Setup complete. Open .toolpilot/tracker.html to monitor tool calls.'
        : 'After completing setup steps, call init_project_config to initialize .toolpilot/config.json.',
    });
  } catch (e) {
    logger.error({ err: e }, 'toolpilot_init failed');
    return errResult('init_error', e instanceof Error ? e.message : String(e));
  }
}

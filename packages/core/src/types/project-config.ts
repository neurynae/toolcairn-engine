// ToolCairn Project Config — persisted as .toolcairn/config.json in the user's project root.
// The MCP server (stdio) cannot read/write files directly.
// The agent reads/writes the file; MCP tools process the content.

// 'toolpilot' kept for backward compat with configs created before the ToolCairn rename
export type ToolSource = 'toolcairn' | 'toolpilot' | 'manual' | 'non_oss';

export interface ConfirmedTool {
  /** Tool name as indexed in ToolPilot (or user-provided name for non_oss/manual) */
  name: string;
  /** How this tool was sourced */
  source: ToolSource;
  /** GitHub URL if available */
  github_url?: string;
  /** Pinned version, e.g. "^5.0.0" */
  version?: string;
  /** ISO timestamp when confirmed (canonical field) */
  chosen_at: string;
  /** Alias for chosen_at used in some older configs */
  confirmed_at?: string;
  /** ISO timestamp of last verification/re-check (used for staleness) */
  last_verified?: string;
  /** Why this tool was chosen */
  chosen_reason: string;
  /** Tool names that were considered but not chosen */
  alternatives_considered: string[];
  /** query_id from search_tools session that recommended this tool */
  query_id?: string;
  /** Notes about proprietary licensing, pricing, etc. */
  notes?: string;
}

export interface PendingTool {
  /** Tool name or category description */
  name: string;
  /** Tool category */
  category: string;
  /** ISO timestamp when added */
  added_at: string;
}

export interface ConfigAuditEntry {
  action: 'add_tool' | 'remove_tool' | 'update_tool' | 'add_evaluation' | 'init';
  tool: string;
  /** ISO timestamp */
  timestamp: string;
  reason: string;
}

export interface ToolPilotProjectConfig {
  /** Config schema version */
  version: '1.0';
  project: {
    name: string;
    /** Primary language/runtime, e.g. "TypeScript", "Python" */
    language: string;
    /** Primary framework, e.g. "Next.js", "FastAPI" */
    framework?: string;
  };
  tools: {
    /** Tools that have been selected and confirmed for use */
    confirmed: ConfirmedTool[];
    /** Tools under evaluation — not yet confirmed */
    pending_evaluation: PendingTool[];
  };
  /** Chronological log of all config mutations */
  audit_log: ConfigAuditEntry[];
}

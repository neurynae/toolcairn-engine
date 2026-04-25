import type { ConfigAuditEntry } from '@toolcairn/types';

/**
 * Generate the standalone tracker.html with the audit data baked inline.
 *
 * The HTML embeds `{ rootName, generatedAt, entries }` as a
 * `<script id="audit-data" type="application/json">` block. On page open
 * the dashboard reads that block synchronously and renders — no fetch,
 * no folder picker, no permission prompt, works on `file://` in any
 * browser. To stay close-to-fresh, the MCP server rewrites this whole
 * file on startup AND after every audit-log append (debounced); the
 * page auto-refreshes via `location.reload()` on a user-tunable timer.
 *
 * `entries` should be the parsed contents of
 * `<projectRoot>/.toolcairn/audit-log.jsonl`. Pass an empty array if the
 * file is absent — the dashboard renders with the empty-state banner.
 */
export interface GenerateTrackerHtmlOptions {
  /** Display label for the dashboard header pill (e.g. the project root name). */
  rootName: string;
  /** All audit entries, in any order — the dashboard sorts newest-first. */
  entries: ConfigAuditEntry[];
}

export function generateTrackerHtml(opts: GenerateTrackerHtmlOptions): string {
  const payload = {
    rootName: opts.rootName,
    generatedAt: new Date().toISOString(),
    entries: opts.entries,
  };
  // JSON-in-HTML escape: `</` and `<!` → unicode-escaped to prevent
  // the audit data from prematurely closing the surrounding <script> tag
  // or starting an HTML comment, both of which would break the dashboard
  // and let an attacker-controlled `reason` / `metadata.query` field
  // inject arbitrary HTML.
  const dataJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return TRACKER_HTML_TEMPLATE.replace('__AUDIT_DATA_JSON__', dataJson);
}

const TRACKER_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ToolCairn Tracker</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a26;
    --border: #2a2a3a;
    --accent: #7c5cfc;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #f59e0b;
    --blue: #38bdf8;
    --text: #e2e8f0;
    --muted: #64748b;
    --mono: 'JetBrains Mono', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; font-size: 14px; min-height: 100vh; }

  header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
  header h1 span { color: var(--accent); }
  .root-pill { font-family: var(--mono); font-size: 12px; padding: 4px 10px; border-radius: 6px; background: rgba(124,92,252,.12); color: var(--accent); border: 1px solid rgba(124,92,252,.3); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; margin-left: auto; }
  .status-dot.paused { background: var(--yellow); animation: none; }
  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }
  .status-text { font-size: 12px; color: var(--muted); }

  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); cursor: pointer; font-size: 12px; transition: all .15s; font-family: inherit; }
  .btn:hover { border-color: var(--accent); }
  .btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  input[type=range] { accent-color: var(--accent); }
  .label { color: var(--muted); font-size: 12px; }
  .filter-input { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); font-size: 12px; font-family: inherit; min-width: 200px; }
  .filter-input:focus { outline: none; border-color: var(--accent); }

  .empty-banner { padding: 32px 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .empty-banner code { font-family: var(--mono); font-size: 12px; background: var(--surface2); padding: 2px 6px; border-radius: 4px; color: var(--accent); }

  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .metric { background: var(--surface); padding: 14px 18px; }
  .metric-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .metric-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .metric-value.green { color: var(--green); }
  .metric-value.red { color: var(--red); }
  .metric-value.accent { color: var(--accent); }
  .metric-value.yellow { color: var(--yellow); }
  .metric-value.blue { color: var(--blue); }
  .metric-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .layout { display: grid; grid-template-columns: 1fr 380px; }
  @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .sidebar { border-top: 1px solid var(--border); } }
  .feed { overflow-y: auto; max-height: calc(100vh - 220px); border-right: 1px solid var(--border); }
  .sidebar { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - 220px); overflow-y: auto; }

  .event-row { display: grid; grid-template-columns: 70px 130px 1fr auto auto; gap: 10px; align-items: center; padding: 7px 16px; border-bottom: 1px solid #181822; transition: background .1s; cursor: pointer; }
  .event-row:hover { background: var(--surface2); }
  .event-row.selected { background: #221b3a; border-left: 2px solid var(--accent); padding-left: 14px; }
  .event-row .time { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .event-row .tool { font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-row .tool.config { color: var(--blue); }
  .event-row .summary { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-row .dur { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; }
  .badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .badge.ok { background: rgba(34,197,94,.15); color: var(--green); }
  .badge.error { background: rgba(239,68,68,.15); color: var(--red); }

  .detail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .detail-card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px solid #181822; font-size: 12px; }
  .kv:last-child { border-bottom: none; }
  .kv .k { color: var(--muted); }
  .kv .v { font-family: var(--mono); color: var(--text); text-align: right; word-break: break-all; max-width: 220px; }
  .kv .v.green { color: var(--green); }
  .kv .v.red { color: var(--red); }
  .kv .v.yellow { color: var(--yellow); }

  .meta-block { font-family: var(--mono); font-size: 11px; color: var(--text); background: #0d0d14; border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-top: 8px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

  .bar-chart { margin-top: 6px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 11px; }
  .bar-label { width: 130px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; font-family: var(--mono); }
  .bar-track { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; }
  .bar-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width .3s; }
  .bar-fill.config { background: var(--blue); }
  .bar-count { width: 30px; text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }

  .pending-list { display: flex; flex-direction: column; gap: 6px; }
  .pending-item { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); border-radius: 6px; padding: 8px 10px; font-size: 12px; }
  .pending-item .pi-tool { color: var(--yellow); font-family: var(--mono); font-weight: 600; }
  .pending-item .pi-meta { color: var(--muted); margin-top: 2px; font-size: 11px; }
  .pending-item .pi-cands { color: var(--text); font-family: var(--mono); font-size: 11px; margin-top: 4px; }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent); }
</style>
</head>
<body>

<header>
  <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="10" r="9" stroke="#7c5cfc" stroke-width="1.5"/>
    <path d="M6 10h8M10 6v8" stroke="#7c5cfc" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
  <h1><span>Tool</span>Cairn Tracker</h1>
  <span class="root-pill" id="rootPill">root</span>
  <div class="status-text" id="statusText">&mdash;</div>
  <div class="status-dot" id="statusDot"></div>
</header>

<div class="controls">
  <button class="btn active" id="btnAuto" title="Toggle auto-refresh">&#9679; Auto-refresh</button>
  <span class="label">every</span>
  <input type="range" min="2" max="30" value="5" id="intervalSlider" style="width:80px;" />
  <span class="label" id="intervalLabel">5s</span>
  <button class="btn" id="btnRefresh">&#x21bb; Reload now</button>
  <input class="filter-input" id="filterInput" placeholder="Filter by tool / query_id / text&hellip;" />
  <button class="btn" id="btnClearFilter">Clear</button>
  <span style="margin-left:auto; font-size:11px; color:var(--muted);" id="generatedAt">&mdash;</span>
</div>

<div class="metrics" id="metrics">
  <div class="metric"><div class="metric-label">Total Entries</div><div class="metric-value accent" id="mTotal">0</div></div>
  <div class="metric"><div class="metric-label">Tool Calls</div><div class="metric-value" id="mToolCalls">0</div><div class="metric-sub" id="mToolCallsSub">&mdash;</div></div>
  <div class="metric"><div class="metric-label">Config Mutations</div><div class="metric-value blue" id="mConfig">0</div></div>
  <div class="metric"><div class="metric-label">Success Rate</div><div class="metric-value green" id="mSuccess">&mdash;</div></div>
  <div class="metric"><div class="metric-label">Avg Tool Latency</div><div class="metric-value" id="mLatency">&mdash;</div></div>
  <div class="metric"><div class="metric-label">Outcomes Reported</div><div class="metric-value green" id="mOutcomes">0</div><div class="metric-sub" id="mOutcomesSub">&mdash;</div></div>
  <div class="metric"><div class="metric-label">Pending Outcomes</div><div class="metric-value yellow" id="mPending">0</div><div class="metric-sub">awaiting report_outcome</div></div>
</div>

<div class="layout">
  <div class="feed" id="feed">
    <div class="empty-banner" id="feedEmpty" style="display:none">
      No entries yet. Run any MCP tool or mutate <code>.toolcairn/config.json</code> and the dashboard will populate on next refresh.
    </div>
  </div>
  <div class="sidebar">
    <div class="detail-card" id="detailPanel" style="display:none">
      <h3>Entry detail</h3>
      <div id="detailContent"></div>
    </div>
    <div class="detail-card">
      <h3>Pending outcomes</h3>
      <div class="pending-list" id="pendingList"></div>
    </div>
    <div class="detail-card">
      <h3>By MCP tool</h3>
      <div id="toolChart" class="bar-chart"></div>
    </div>
    <div class="detail-card">
      <h3>By config action</h3>
      <div id="actionChart" class="bar-chart"></div>
    </div>
  </div>
</div>

<!--
  Audit data is embedded inline by the MCP server. The server rewrites this
  whole file on startup AND after every audit-log append (debounced), so
  opening this file in a browser shows the latest snapshot with no fetch,
  no folder picker, no permission prompt. Auto-refresh below just does
  location.reload() on a timer.
-->
<script id="audit-data" type="application/json">__AUDIT_DATA_JSON__</script>

<script>
const PENDING_TTL_DAYS = 7;
const RECOMMENDATION_TOOLS = new Set(['search_tools', 'search_tools_respond', 'get_stack']);

let DATA = { rootName: 'root', generatedAt: null, entries: [] };
try {
  DATA = JSON.parse(document.getElementById('audit-data').textContent || '{}');
  if (!Array.isArray(DATA.entries)) DATA.entries = [];
} catch { /* malformed embedded data — empty dashboard */ }

const state = {
  selectedKey: null,
  textFilter: '',
  reloadMs: 5000,
  reloadHandle: null,
  autoOn: true,
};

DATA.entries.forEach((e, idx) => {
  e._key = (e.timestamp || '') + '::' + (e.action || '') + '::' + (e.tool || '') + '::' + (e.mcp_tool || '') + '::' + (e.query_id || '') + '::' + idx;
});
DATA.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

document.getElementById('rootPill').textContent = DATA.rootName || 'root';
document.getElementById('generatedAt').textContent = DATA.generatedAt
  ? 'Generated ' + new Date(DATA.generatedAt).toLocaleTimeString()
  : '';

function filteredEntries() {
  if (!state.textFilter) return DATA.entries;
  const q = state.textFilter.toLowerCase();
  return DATA.entries.filter((e) => {
    const hay = ((e.action || '') + ' ' + (e.mcp_tool || '') + ' ' + (e.tool || '') + ' ' + (e.query_id || '') + ' ' + (e.reason || '') + ' ' + JSON.stringify(e.metadata || {})).toLowerCase();
    return hay.includes(q);
  });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFeed() {
  const feed = document.getElementById('feed');
  const empty = document.getElementById('feedEmpty');
  feed.querySelectorAll('.event-row').forEach((r) => r.remove());
  const list = filteredEntries();
  if (list.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  for (const e of list.slice(0, 500)) {
    const row = document.createElement('div');
    row.className = 'event-row' + (state.selectedKey === e._key ? ' selected' : '');
    row.dataset.key = e._key;
    row.onclick = () => { state.selectedKey = e._key; renderAll(); };
    const isToolCall = e.action === 'tool_call';
    const tool = isToolCall ? (e.mcp_tool || '?') : e.action;
    const summary = buildSummary(e);
    const dur = (typeof e.duration_ms === 'number') ? (e.duration_ms + 'ms') : '';
    const status = e.status || 'ok';
    row.innerHTML =
      '<span class="time">' + fmtTime(e.timestamp) + '</span>' +
      '<span class="tool ' + (isToolCall ? 'mcp' : 'config') + '" title="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</span>' +
      '<span class="summary">' + escapeHtml(summary) + '</span>' +
      '<span class="dur">' + dur + '</span>' +
      '<span class="badge ' + status + '">' + status + '</span>';
    feed.appendChild(row);
  }
}

function buildSummary(e) {
  if (e.action === 'tool_call') {
    if (e.outcome) {
      const target = e.tool && !e.tool.startsWith('__') ? (e.tool + ' → ') : '';
      const replaced = e.replaced_by ? (' (→ ' + e.replaced_by + ')') : '';
      return target + e.outcome + replaced;
    }
    if (e.candidates && e.candidates.length > 0) return 'top: ' + e.candidates.slice(0, 3).join(', ');
    if (e.reason) return e.reason;
    return '';
  }
  if (e.action === 'init') {
    const m = e.metadata;
    if (m && m.project_name) return m.project_name + ': ' + (m.tools_scanned ?? 0) + ' tools, ' + (m.unknown_in_graph ?? 0) + ' unknown';
    return e.reason || '';
  }
  if (e.action === 'mark_suggestions_sent') {
    const m = e.metadata;
    return ((m?.tool_count) ?? 0) + ' tools staged: ' + ((m?.tool_names) || []).slice(0, 3).join(', ');
  }
  if (e.action === 'add_tool' || e.action === 'remove_tool' || e.action === 'update_tool' || e.action === 'add_evaluation') {
    return e.tool + (e.metadata?.version ? (' @ ' + e.metadata.version) : '');
  }
  return e.reason || '';
}

function renderMetrics() {
  const list = filteredEntries();
  const total = list.length;
  const toolCalls = list.filter((e) => e.action === 'tool_call');
  const config = list.filter((e) => e.action !== 'tool_call');
  const ok = list.filter((e) => (e.status ?? 'ok') === 'ok').length;
  const tcDurations = toolCalls.filter((e) => typeof e.duration_ms === 'number').map((e) => e.duration_ms);
  const avgMs = tcDurations.length > 0 ? Math.round(tcDurations.reduce((a, b) => a + b, 0) / tcDurations.length) : null;
  const outcomes = toolCalls.filter((e) => e.mcp_tool === 'report_outcome');
  const successOutcomes = outcomes.filter((e) => e.outcome === 'success').length;
  document.getElementById('mTotal').textContent = total;
  document.getElementById('mToolCalls').textContent = toolCalls.length;
  document.getElementById('mToolCallsSub').textContent = total > 0 ? (Math.round(toolCalls.length/total*100) + '% of total') : '—';
  document.getElementById('mConfig').textContent = config.length;
  document.getElementById('mSuccess').textContent = total > 0 ? (Math.round(ok / total * 100) + '%') : '—';
  document.getElementById('mLatency').textContent = avgMs !== null ? (avgMs + 'ms') : '—';
  document.getElementById('mOutcomes').textContent = outcomes.length;
  document.getElementById('mOutcomesSub').textContent = outcomes.length > 0 ? (successOutcomes + ' success / ' + (outcomes.length - successOutcomes) + ' other') : '—';
  document.getElementById('mPending').textContent = derivePending().length;
}

function derivePending() {
  const cutoff = Date.now() - PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;
  const open = new Map();
  const chrono = [...DATA.entries].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const e of chrono) {
    if (e.action !== 'tool_call' || !e.query_id) continue;
    if (e.status === 'error') continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    if (RECOMMENDATION_TOOLS.has(e.mcp_tool)) {
      open.set(e.query_id, {
        query_id: e.query_id,
        mcp_tool: e.mcp_tool,
        selected_at: e.timestamp,
        age_hours: Math.round((Date.now() - ts) / (1000 * 60 * 60)),
        candidates: e.candidates ?? [],
        query: e.metadata?.query ?? e.metadata?.use_case ?? null,
      });
    } else if (e.mcp_tool === 'report_outcome') {
      open.delete(e.query_id);
    }
  }
  return Array.from(open.values()).sort((a, b) => new Date(a.selected_at) - new Date(b.selected_at));
}

function renderPending() {
  const list = derivePending();
  const root = document.getElementById('pendingList');
  if (list.length === 0) {
    root.innerHTML = '<div style="color:var(--muted);font-size:12px;">All recommendations have outcomes \\u{1F389}</div>';
    return;
  }
  root.innerHTML = list.slice(0, 12).map((p) =>
    '<div class="pending-item">' +
      '<div class="pi-tool">' + escapeHtml(p.mcp_tool) + '</div>' +
      '<div class="pi-meta">query_id ' + escapeHtml(p.query_id.slice(0, 12)) + ' · ' + p.age_hours + 'h ago' +
        (p.query ? (' · "' + escapeHtml(p.query.slice(0, 60)) + '"') : '') +
      '</div>' +
      (p.candidates.length > 0 ? ('<div class="pi-cands">' + escapeHtml(p.candidates.slice(0, 4).join(' · ')) + '</div>') : '') +
    '</div>'
  ).join('');
}

function renderToolChart() {
  const list = filteredEntries().filter((e) => e.action === 'tool_call');
  const counts = {};
  for (const e of list) counts[e.mcp_tool || '?'] = (counts[e.mcp_tool || '?'] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = sorted[0]?.[1] || 1;
  const html = sorted.map((entry) => {
    const tool = entry[0];
    const n = entry[1];
    return '<div class="bar-row">' +
      '<span class="bar-label">' + escapeHtml(tool) + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (n/max*100) + '%"></div></div>' +
      '<span class="bar-count">' + n + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('toolChart').innerHTML = html || '<span style="color:var(--muted);font-size:12px">No tool calls yet</span>';
}

function renderActionChart() {
  const list = filteredEntries().filter((e) => e.action !== 'tool_call');
  const counts = {};
  for (const e of list) counts[e.action] = (counts[e.action] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = sorted[0]?.[1] || 1;
  const html = sorted.map((entry) => {
    const action = entry[0];
    const n = entry[1];
    return '<div class="bar-row">' +
      '<span class="bar-label">' + escapeHtml(action) + '</span>' +
      '<div class="bar-track"><div class="bar-fill config" style="width:' + (n/max*100) + '%"></div></div>' +
      '<span class="bar-count">' + n + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('actionChart').innerHTML = html || '<span style="color:var(--muted);font-size:12px">No config mutations yet</span>';
}

function renderDetail() {
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');
  if (!state.selectedKey) { panel.style.display = 'none'; return; }
  const e = DATA.entries.find((x) => x._key === state.selectedKey);
  if (!e) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const rows = [
    ['Action', e.action],
    e.mcp_tool ? ['MCP tool', e.mcp_tool] : null,
    ['Tool', e.tool],
    ['Status', e.status ?? 'ok'],
    typeof e.duration_ms === 'number' ? ['Duration', e.duration_ms + 'ms'] : null,
    e.query_id ? ['Query id', e.query_id] : null,
    e.outcome ? ['Outcome', e.outcome] : null,
    e.replaced_by ? ['Replaced by', e.replaced_by] : null,
    ['Timestamp', new Date(e.timestamp).toLocaleString()],
    ['Reason', e.reason || ''],
  ].filter(Boolean);
  let html = rows.map((row) => {
    const k = row[0];
    const v = row[1];
    const cls = v === 'ok' || v === 'success' ? 'green' : (v === 'error' || v === 'failure') ? 'red' : (v === 'replaced' || v === 'pending') ? 'yellow' : '';
    return '<div class="kv"><span class="k">' + escapeHtml(k) + '</span><span class="v ' + cls + '">' + escapeHtml(v) + '</span></div>';
  }).join('');
  if (e.candidates && e.candidates.length > 0) {
    html += '<div class="kv"><span class="k">Candidates</span><span class="v">' + escapeHtml(e.candidates.join(', ')) + '</span></div>';
  }
  if (e.metadata && Object.keys(e.metadata).length > 0) {
    html += '<div class="meta-block">' + escapeHtml(JSON.stringify(e.metadata, null, 2)) + '</div>';
  }
  content.innerHTML = html;
}

function renderAll() {
  renderMetrics();
  renderFeed();
  renderToolChart();
  renderActionChart();
  renderPending();
  renderDetail();
  updateStatusDot();
}

function updateStatusDot() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (state.autoOn) {
    dot.className = 'status-dot';
    txt.textContent = DATA.entries.length + ' entries · auto-refresh every ' + (state.reloadMs / 1000) + 's';
  } else {
    dot.className = 'status-dot paused';
    txt.textContent = DATA.entries.length + ' entries · paused';
  }
}

function startAuto() {
  stopAuto();
  if (!state.autoOn) return;
  state.reloadHandle = setInterval(() => location.reload(), state.reloadMs);
}
function stopAuto() {
  if (state.reloadHandle) { clearInterval(state.reloadHandle); state.reloadHandle = null; }
}

document.getElementById('btnAuto').addEventListener('click', () => {
  state.autoOn = !state.autoOn;
  document.getElementById('btnAuto').classList.toggle('active', state.autoOn);
  if (state.autoOn) startAuto(); else stopAuto();
  updateStatusDot();
});
document.getElementById('btnRefresh').addEventListener('click', () => location.reload());
document.getElementById('intervalSlider').addEventListener('input', (e) => {
  state.reloadMs = Number(e.target.value) * 1000;
  document.getElementById('intervalLabel').textContent = e.target.value + 's';
  if (state.autoOn) startAuto();
  updateStatusDot();
});
document.getElementById('filterInput').addEventListener('input', (e) => {
  state.textFilter = e.target.value;
  renderAll();
});
document.getElementById('btnClearFilter').addEventListener('click', () => {
  state.textFilter = '';
  document.getElementById('filterInput').value = '';
  renderAll();
});

renderAll();
startAuto();
</script>

</body>
</html>
`;

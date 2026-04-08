/**
 * Generate the standalone tracker.html content.
 * Called by toolpilot_init to produce the HTML file content.
 * The agent writes the returned content to .toolpilot/tracker.html
 */
export function generateTrackerHtml(eventsPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ToolPilot Tracker</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a26;
    --border: #2a2a3a;
    --accent: #7c5cfc;
    --accent2: #5b8def;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #f59e0b;
    --text: #e2e8f0;
    --muted: #64748b;
    --mono: 'JetBrains Mono', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; font-size: 14px; min-height: 100vh; }

  header { display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
  header h1 span { color: var(--accent); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; margin-left: auto; }
  .status-dot.paused { background: var(--yellow); animation: none; }
  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }

  .controls { display: flex; gap: 8px; align-items: center; padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .btn { padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); cursor: pointer; font-size: 12px; transition: border-color .15s; }
  .btn:hover { border-color: var(--accent); }
  .btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  input[type=range] { accent-color: var(--accent); }
  .label { color: var(--muted); font-size: 12px; }

  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .metric { background: var(--surface); padding: 14px 18px; }
  .metric-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .metric-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .metric-value.green { color: var(--green); }
  .metric-value.red { color: var(--red); }
  .metric-value.accent { color: var(--accent); }
  .metric-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .layout { display: grid; grid-template-columns: 1fr 340px; height: calc(100vh - 140px); }
  .feed { overflow-y: auto; border-right: 1px solid var(--border); }
  .sidebar { overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }

  .event-row { display: grid; grid-template-columns: 80px 160px 1fr auto auto; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid #1a1a22; transition: background .1s; cursor: pointer; }
  .event-row:hover { background: var(--surface2); }
  .event-row.selected { background: #1e1a30; }
  .event-row .time { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .event-row .tool { font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 600; }
  .event-row .summary { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-row .dur { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; }
  .badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.ok { background: rgba(34,197,94,.15); color: var(--green); }
  .badge.error { background: rgba(239,68,68,.15); color: var(--red); }
  .badge.warn { background: rgba(245,158,11,.15); color: var(--yellow); }

  .detail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .detail-card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1a1a22; font-size: 12px; }
  .kv:last-child { border-bottom: none; }
  .kv .k { color: var(--muted); }
  .kv .v { font-family: var(--mono); color: var(--text); }
  .kv .v.green { color: var(--green); }
  .kv .v.red { color: var(--red); }
  .kv .v.yellow { color: var(--yellow); }

  .bar-chart { margin-top: 6px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 11px; }
  .bar-label { width: 120px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .bar-track { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; }
  .bar-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width .3s; }
  .bar-count { width: 28px; text-align: right; color: var(--text); }

  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--muted); gap: 8px; }
  .empty svg { opacity: .3; }
  .empty p { font-size: 13px; }
  .empty code { font-family: var(--mono); font-size: 11px; background: var(--surface2); padding: 3px 8px; border-radius: 4px; color: var(--accent); }

  .insights-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .insight-item { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 12px; }
  .insight-item .i-tool { color: var(--accent); font-family: var(--mono); font-weight: 600; }
  .insight-item .i-text { color: var(--muted); margin-top: 2px; }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
</head>
<body>

<header>
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="9" stroke="#7c5cfc" stroke-width="1.5"/>
    <path d="M6 10h8M10 6v8" stroke="#7c5cfc" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
  <h1><span>Tool</span>Pilot Tracker</h1>
  <div id="statusText" style="font-size:12px; color:var(--muted);">Loading...</div>
  <div id="statusDot" class="status-dot paused"></div>
</header>

<div class="controls">
  <button class="btn active" id="btnLive" onclick="toggleLive()">⬤ Live</button>
  <button class="btn" id="btnClear" onclick="clearEvents()">Clear</button>
  <span class="label" style="margin-left:8px;">Interval:</span>
  <input type="range" min="1" max="30" value="3" id="intervalSlider" onchange="setInterval_(this.value)" style="width:80px;" />
  <span class="label" id="intervalLabel">3s</span>
  <span style="margin-left:auto; font-size:11px; color:var(--muted);" id="lastRefresh">—</span>
</div>

<div class="metrics" id="metrics">
  <div class="metric"><div class="metric-label">Total Calls</div><div class="metric-value accent" id="mTotal">0</div></div>
  <div class="metric"><div class="metric-label">Success Rate</div><div class="metric-value green" id="mSuccess">—</div></div>
  <div class="metric"><div class="metric-label">Avg Latency</div><div class="metric-value" id="mLatency">—</div></div>
  <div class="metric"><div class="metric-label">Issues Caught</div><div class="metric-value yellow" id="mIssues">0</div><div class="metric-sub">check_issue calls</div></div>
  <div class="metric"><div class="metric-label">Deprecation Warns</div><div class="metric-value yellow" id="mDeprecation">0</div></div>
  <div class="metric"><div class="metric-label">Non-OSS Guided</div><div class="metric-value" id="mNonOss">0</div></div>
  <div class="metric"><div class="metric-label">Graph Updates</div><div class="metric-value accent" id="mGraph">0</div></div>
</div>

<div class="layout">
  <div class="feed" id="feed">
    <div class="empty" id="emptyState">
      <svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M13 20h14M20 13v14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <p>Waiting for MCP tool calls...</p>
      <code>Set TOOLPILOT_EVENTS_PATH in your MCP server env</code>
    </div>
  </div>
  <div class="sidebar">
    <div class="detail-card" id="detailPanel" style="display:none">
      <h3>Event Detail</h3>
      <div id="detailContent"></div>
    </div>
    <div class="detail-card">
      <h3>Calls by Tool</h3>
      <div id="toolChart" class="bar-chart"></div>
    </div>
    <div class="detail-card">
      <h3>Recent Insights</h3>
      <ul class="insights-list" id="insightsList"></ul>
    </div>
  </div>
</div>

<script>
// ─── Config ──────────────────────────────────────────────────────────────────
const EVENTS_PATH = ${JSON.stringify(eventsPath)};

// ─── State ───────────────────────────────────────────────────────────────────
let allEvents = [];
let selectedId = null;
let isLive = true;
let pollIntervalMs = 3000;
let pollHandle = null;
let lastByteOffset = 0;

// ─── Polling ──────────────────────────────────────────────────────────────────
async function fetchEvents() {
  if (!EVENTS_PATH) return;
  try {
    // Fetch with range header to only get new bytes
    const headers = lastByteOffset > 0 ? { 'Range': \`bytes=\${lastByteOffset}-\` } : {};
    const res = await fetch(\`file://\${EVENTS_PATH}\`, { headers }).catch(() => null);
    if (!res) return;

    const text = await res.text();
    if (!text.trim()) return;

    const newLines = text.trim().split('\\n').filter(Boolean);
    let added = 0;
    for (const line of newLines) {
      try {
        const ev = JSON.parse(line);
        if (!allEvents.find(e => e.id === ev.id)) {
          allEvents.push(ev);
          added++;
        }
      } catch {}
    }

    if (added > 0) {
      allEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      renderAll();
    }

    document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
    document.getElementById('statusDot').className = 'status-dot' + (isLive ? '' : ' paused');
    document.getElementById('statusText').textContent = \`\${allEvents.length} events\`;
  } catch (e) {
    console.warn('Fetch error', e);
  }
}

function toggleLive() {
  isLive = !isLive;
  document.getElementById('btnLive').className = 'btn' + (isLive ? ' active' : '');
  document.getElementById('statusDot').className = 'status-dot' + (isLive ? '' : ' paused');
  if (isLive) startPolling(); else stopPolling();
}

function clearEvents() {
  allEvents = [];
  selectedId = null;
  renderAll();
}

function setInterval_(v) {
  pollIntervalMs = Number(v) * 1000;
  document.getElementById('intervalLabel').textContent = v + 's';
  if (isLive) { stopPolling(); startPolling(); }
}

function startPolling() {
  if (pollHandle) clearInterval(pollHandle);
  fetchEvents();
  pollHandle = setInterval(fetchEvents, pollIntervalMs);
}

function stopPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toolSummary(ev) {
  const m = ev.metadata || {};
  if (ev.tool_name === 'search_tools' || ev.tool_name === 'search_tools_respond') {
    const parts = [];
    if (m.is_two_option) parts.push('2-option result');
    if (m.had_non_indexed_guidance) parts.push('non-OSS guidance');
    if (m.had_deprecation_warning) parts.push('⚠ deprecated tool');
    if (m.had_credibility_warning) parts.push('⚠ low-stars warning');
    return parts.join(' · ') || m.status || '';
  }
  if (ev.tool_name === 'check_issue') return m.status ? \`status: \${m.status}\` : '';
  if (ev.tool_name === 'suggest_graph_update') {
    if (m.auto_graduated) return '✓ auto-graduated to graph';
    if (m.staged) return 'staged for review';
    return '';
  }
  if (ev.tool_name === 'compare_tools') return m.recommendation ? \`rec: \${m.recommendation}\` : '';
  if (ev.tool_name === 'check_compatibility') return m.compatibility_signal ? m.compatibility_signal : '';
  return m.status || '';
}

function renderFeed() {
  const feed = document.getElementById('feed');
  const empty = document.getElementById('emptyState');
  if (allEvents.length === 0) {
    empty.style.display = 'flex';
    feed.querySelectorAll('.event-row').forEach(r => r.remove());
    return;
  }
  empty.style.display = 'none';

  // Remove rows not in allEvents
  const existingIds = new Set(Array.from(feed.querySelectorAll('.event-row')).map(r => r.dataset.id));
  const currentIds = new Set(allEvents.map(e => e.id));
  existingIds.forEach(id => { if (!currentIds.has(id)) feed.querySelector(\`[data-id="\${id}"]\`)?.remove(); });

  // Add new rows at top
  for (const ev of allEvents) {
    if (feed.querySelector(\`[data-id="\${ev.id}"]\`)) continue;
    const row = document.createElement('div');
    row.className = 'event-row' + (selectedId === ev.id ? ' selected' : '');
    row.dataset.id = ev.id;
    row.onclick = () => selectEvent(ev.id);

    const badgeClass = ev.status === 'ok' ? 'ok' : 'error';
    const summary = toolSummary(ev);
    row.innerHTML = \`
      <span class="time">\${fmtTime(ev.created_at)}</span>
      <span class="tool">\${ev.tool_name}</span>
      <span class="summary">\${summary}</span>
      <span class="dur">\${ev.duration_ms}ms</span>
      <span class="badge \${badgeClass}">\${ev.status}</span>
    \`;

    // Insert in chronological order (newest first)
    const firstRow = feed.querySelector('.event-row');
    if (firstRow) feed.insertBefore(row, firstRow);
    else feed.appendChild(row);
  }
}

function renderMetrics() {
  const total = allEvents.length;
  const okCount = allEvents.filter(e => e.status === 'ok').length;
  const avgMs = total > 0 ? Math.round(allEvents.reduce((s, e) => s + e.duration_ms, 0) / total) : 0;
  const issueCount = allEvents.filter(e => e.tool_name === 'check_issue').length;
  const deprecCount = allEvents.filter(e => e.metadata?.had_deprecation_warning).length;
  const nonOssCount = allEvents.filter(e => e.metadata?.had_non_indexed_guidance).length;
  const graphCount = allEvents.filter(e => e.tool_name === 'suggest_graph_update').length;

  document.getElementById('mTotal').textContent = total;
  document.getElementById('mSuccess').textContent = total > 0 ? Math.round(okCount / total * 100) + '%' : '—';
  document.getElementById('mLatency').textContent = total > 0 ? avgMs + 'ms' : '—';
  document.getElementById('mIssues').textContent = issueCount;
  document.getElementById('mDeprecation').textContent = deprecCount;
  document.getElementById('mNonOss').textContent = nonOssCount;
  document.getElementById('mGraph').textContent = graphCount;
}

function renderToolChart() {
  const counts = {};
  for (const ev of allEvents) counts[ev.tool_name] = (counts[ev.tool_name] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted[0]?.[1] || 1;
  const html = sorted.map(([tool, count]) => \`
    <div class="bar-row">
      <span class="bar-label">\${tool}</span>
      <div class="bar-track"><div class="bar-fill" style="width:\${count/max*100}%"></div></div>
      <span class="bar-count">\${count}</span>
    </div>
  \`).join('');
  document.getElementById('toolChart').innerHTML = html || '<span style="color:var(--muted);font-size:12px">No data yet</span>';
}

function renderInsights() {
  const insights = [];
  for (const ev of allEvents.slice(0, 50)) {
    const m = ev.metadata || {};
    if (ev.tool_name === 'check_issue' && ev.status === 'ok') {
      insights.push({ tool: ev.tool_name, text: 'Issue check ran — may have prevented a debug loop', time: ev.created_at });
    }
    if (m.had_deprecation_warning) {
      insights.push({ tool: ev.tool_name, text: 'Deprecated/unmaintained tool detected in results', time: ev.created_at });
    }
    if (m.auto_graduated) {
      insights.push({ tool: 'suggest_graph_update', text: 'New edge auto-graduated to graph (confidence ≥0.8)', time: ev.created_at });
    }
    if (m.had_non_indexed_guidance) {
      insights.push({ tool: ev.tool_name, text: 'Non-indexed tool detected — non-OSS guidance provided', time: ev.created_at });
    }
    if (m.recommendation) {
      insights.push({ tool: 'compare_tools', text: \`Tool comparison recommended: \${m.recommendation}\`, time: ev.created_at });
    }
  }
  const list = document.getElementById('insightsList');
  if (insights.length === 0) {
    list.innerHTML = '<li style="color:var(--muted);font-size:12px">No insights yet</li>';
    return;
  }
  list.innerHTML = insights.slice(0, 8).map(i => \`
    <li class="insight-item">
      <div class="i-tool">\${i.tool}</div>
      <div class="i-text">\${i.text}</div>
    </li>
  \`).join('');
}

function selectEvent(id) {
  selectedId = id;
  document.querySelectorAll('.event-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));
  const ev = allEvents.find(e => e.id === id);
  if (!ev) return;
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');
  panel.style.display = 'block';
  const m = ev.metadata || {};
  const rows = [
    ['Tool', ev.tool_name],
    ['Status', ev.status],
    ['Duration', ev.duration_ms + 'ms'],
    ['Time', new Date(ev.created_at).toLocaleString()],
    ev.query_id ? ['Session ID', ev.query_id.slice(0, 8) + '...'] : null,
    ...Object.entries(m).filter(([k]) => k !== 'tool').map(([k, v]) => [k, String(v)])
  ].filter(Boolean);
  content.innerHTML = rows.map(([k, v]) => {
    const cls = v === 'true' || v === 'ok' ? 'green' : v === 'false' || v === 'error' ? 'red' : '';
    return \`<div class="kv"><span class="k">\${k}</span><span class="v \${cls}">\${v}</span></div>\`;
  }).join('');
}

function renderAll() {
  renderFeed();
  renderMetrics();
  renderToolChart();
  renderInsights();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
if (!EVENTS_PATH || EVENTS_PATH === 'null') {
  document.getElementById('statusText').textContent = 'No events path configured';
  document.getElementById('emptyState').querySelector('p').textContent = 'TOOLPILOT_EVENTS_PATH not set in MCP server environment';
} else {
  startPolling();
}
</script>
</body>
</html>`;
}

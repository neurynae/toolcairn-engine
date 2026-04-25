/**
 * Generate the standalone tracker.html content.
 *
 * The tracker is a self-contained, dependency-free HTML page that reads
 * one or more .toolcairn/audit-log.jsonl files via the File System Access
 * API (Chrome / Edge) or a webkitdirectory <input> fallback (Firefox /
 * Safari / drag-drop). It renders a unified timeline of config-mutation
 * entries AND tool_call entries across every project root in the picked
 * folder, with metrics, filters, and a derived pending_outcomes panel
 * that mirrors the server-side derivation in read_project_config.
 *
 * No runtime parameters needed — the user picks the folder at load time.
 */
export function generateTrackerHtml(): string {
  return `<!DOCTYPE html>
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
    --accent2: #5b8def;
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
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .status-dot.live { background: var(--green); animation: pulse 2s infinite; }
  .status-dot.paused { background: var(--yellow); }
  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }
  .status-text { font-size: 12px; color: var(--muted); }

  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); cursor: pointer; font-size: 12px; transition: all .15s; font-family: inherit; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.1); }
  .btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  input[type=range] { accent-color: var(--accent); }
  .label { color: var(--muted); font-size: 12px; }
  .filter-input { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); font-size: 12px; font-family: inherit; min-width: 200px; }
  .filter-input:focus { outline: none; border-color: var(--accent); }

  .picker-banner { padding: 28px 24px; text-align: center; background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%); border-bottom: 1px solid var(--border); }
  .picker-banner h2 { font-size: 18px; margin-bottom: 8px; }
  .picker-banner p { color: var(--muted); font-size: 13px; margin-bottom: 18px; max-width: 560px; margin-left: auto; margin-right: auto; line-height: 1.6; }
  .picker-banner code { font-family: var(--mono); font-size: 12px; background: var(--surface2); padding: 2px 6px; border-radius: 4px; color: var(--accent); }

  .drop-zone { padding: 22px; border: 2px dashed var(--border); border-radius: 10px; max-width: 480px; margin: 14px auto; cursor: pointer; transition: all .15s; }
  .drop-zone:hover, .drop-zone.over { border-color: var(--accent); background: rgba(124,92,252,.05); }
  .drop-zone .icon { font-size: 24px; opacity: .5; margin-bottom: 6px; }
  .drop-zone .hint { font-size: 12px; color: var(--muted); }

  .picker-fallback { font-size: 11px; color: var(--muted); margin-top: 10px; }

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
  .feed { overflow-y: auto; max-height: calc(100vh - 280px); border-right: 1px solid var(--border); }
  .sidebar { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - 280px); overflow-y: auto; }

  .event-row { display: grid; grid-template-columns: 70px 90px 130px 1fr auto auto; gap: 10px; align-items: center; padding: 7px 16px; border-bottom: 1px solid #181822; transition: background .1s; cursor: pointer; }
  .event-row:hover { background: var(--surface2); }
  .event-row.selected { background: #221b3a; border-left: 2px solid var(--accent); padding-left: 14px; }
  .event-row .time { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .event-row .root { font-family: var(--mono); font-size: 10px; color: var(--blue); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-row .tool { font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  .kv .v.muted { color: var(--muted); }

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

  .root-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .root-tag { padding: 3px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--text); cursor: pointer; transition: all .1s; }
  .root-tag:hover { border-color: var(--accent); }
  .root-tag.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .root-tag.disabled { opacity: 0.45; }
  .root-tag .count { color: var(--muted); margin-left: 6px; }
  .root-tag.active .count { color: rgba(255,255,255,.7); }

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
  <div class="status-text" id="statusText">No folder selected</div>
  <div class="status-dot" id="statusDot"></div>
</header>

<div id="pickerBanner" class="picker-banner">
  <h2>Pick a folder to monitor</h2>
  <p>
    Reads <code>.toolcairn/audit-log.jsonl</code> files in the selected folder and one level deep
    &mdash; covers a single project root or a multi-root workspace. Live updates poll every few seconds.
  </p>
  <button class="btn primary" id="btnPickDir">Choose folder&hellip;</button>
  <div class="drop-zone" id="dropZone">
    <div class="icon">&#128193;</div>
    <div>or drop your project folder here</div>
    <div class="hint">tracker reads every <code>audit-log.jsonl</code> it finds</div>
  </div>
  <div class="picker-fallback">
    No File System Access? <button class="btn" id="btnPickFiles">Pick a folder (Firefox / Safari / static load)</button>
  </div>
  <!--
    The directory <input> form works across all major browsers and gives us
    \`file.webkitRelativePath\` (e.g. "ToolPilot/toolcairn-engine/.toolcairn/audit-log.jsonl")
    which we can split to recover the project root. Live-update polling is
    a no-op for this fallback (browser doesn't refresh File contents on its
    own); user must re-pick to refresh.
  -->
  <input type="file" id="fileInput" webkitdirectory directory multiple style="display:none" />
</div>

<div id="dashboard" style="display:none">
  <div class="controls">
    <button class="btn primary" id="btnRefresh">&#x21bb; Refresh now</button>
    <button class="btn active" id="btnLive">&#9679; Live</button>
    <span class="label" style="margin-left:8px;">Interval:</span>
    <input type="range" min="1" max="30" value="3" id="intervalSlider" style="width:80px;" />
    <span class="label" id="intervalLabel">3s</span>
    <input class="filter-input" id="filterInput" placeholder="Filter by tool / query_id / text&hellip;" />
    <button class="btn" id="btnClearFilter">Clear</button>
    <button class="btn" id="btnReset">&#x2297; Switch folder</button>
    <span style="margin-left:auto; font-size:11px; color:var(--muted);" id="lastRefresh">&mdash;</span>
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
      <div style="padding:40px 16px;text-align:center;color:var(--muted);font-size:13px;" id="feedEmpty">No entries yet &mdash; waiting for activity&hellip;</div>
    </div>
    <div class="sidebar">
      <div class="detail-card" id="detailPanel" style="display:none">
        <h3>Entry detail</h3>
        <div id="detailContent"></div>
      </div>
      <div class="detail-card">
        <h3>Project roots</h3>
        <div class="root-list" id="rootList"></div>
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
</div>

<script>
// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  // Each source: { rootName: string, fileHandle?: FileSystemFileHandle, file?: File, lastSize: number }
  sources: [],
  // Per-source dedup key set so re-reads don't re-insert rows.
  seenKeys: new Set(),
  // Flat parsed entries — unioned across sources.
  entries: [],
  // UI state
  selectedKey: null,
  isLive: true,
  pollMs: 3000,
  pollHandle: null,
  rootFilter: null,
  textFilter: '',
  hasFsa: 'showDirectoryPicker' in window,
};

const PENDING_TTL_DAYS = 7;
const RECOMMENDATION_TOOLS = new Set(['search_tools', 'search_tools_respond', 'get_stack']);

// ─── Folder picker (File System Access API) ─────────────────────────────────
async function pickDirectory() {
  if (!state.hasFsa) {
    alert('Your browser does not support showDirectoryPicker. Use the file picker fallback.');
    return;
  }
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    return; // user cancelled
  }
  await loadFromDirectoryHandle(root);
}

async function loadFromDirectoryHandle(rootHandle) {
  const found = [];
  await collectAuditFiles(rootHandle, '', found, 0);
  if (found.length === 0) {
    alert('No .toolcairn/audit-log.jsonl files found in that folder or its immediate subfolders.');
    return;
  }
  state.sources = found.map((f) => ({ ...f, lastSize: 0 }));
  state.entries = [];
  state.seenKeys = new Set();
  showDashboard();
  await pollAll();
  startPolling();
}

async function collectAuditFiles(dirHandle, relPath, out, depth) {
  // Look for \`.toolcairn/audit-log.jsonl\` directly inside this dir.
  try {
    const toolcairn = await dirHandle.getDirectoryHandle('.toolcairn').catch(() => null);
    if (toolcairn) {
      const file = await toolcairn.getFileHandle('audit-log.jsonl').catch(() => null);
      if (file) {
        const rootName = relPath || dirHandle.name;
        out.push({ rootName, fileHandle: file });
      }
    }
  } catch {}
  // Descend one level (covers monorepo parent → sub-roots).
  if (depth >= 1) return;
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'directory') continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const subRel = relPath ? (relPath + '/' + entry.name) : entry.name;
    await collectAuditFiles(entry, subRel, out, depth + 1);
  }
}

// ─── Drag-drop fallback (uses webkitGetAsEntry for folder drops) ─────────────
function bindDropZone() {
  const zone = document.getElementById('dropZone');
  ['dragenter','dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave','drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('click', () => document.getElementById('btnPickDir').click());
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const items = Array.from(e.dataTransfer.items || []);
    const out = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      if (entry.isDirectory) await walkEntry(entry, '', out, 0);
      else if (entry.isFile) await pushDroppedFile(entry, '', out);
    }
    if (out.length === 0) {
      alert('No audit-log.jsonl files found in the dropped item.');
      return;
    }
    state.sources = out.map((f) => ({ ...f, lastSize: 0 }));
    state.entries = [];
    state.seenKeys = new Set();
    showDashboard();
    await pollAll();
    startPolling();
  });
}

function pushDroppedFile(entry, relPath, out) {
  return new Promise((resolve) => {
    if (!entry.name.endsWith('.jsonl')) return resolve();
    entry.file((file) => {
      const rootName = relPath || 'root';
      out.push({ rootName, file });
      resolve();
    }, () => resolve());
  });
}

async function walkEntry(entry, relPath, out, depth) {
  if (entry.isFile) {
    if (entry.name === 'audit-log.jsonl' && relPath.endsWith('.toolcairn')) {
      const rootName = relPath.replace(/\\.toolcairn$/, '').replace(/^\\//, '') || 'root';
      await pushDroppedFile(entry, rootName, out);
    }
    return;
  }
  if (entry.isDirectory) {
    if (depth >= 3) return;
    if (entry.name.startsWith('.') && entry.name !== '.toolcairn') return;
    if (entry.name === 'node_modules') return;
    const reader = entry.createReader();
    await new Promise((resolve) => {
      reader.readEntries(async (children) => {
        for (const child of children) {
          await walkEntry(child, relPath + '/' + entry.name, out, depth + 1);
        }
        resolve();
      }, () => resolve());
    });
  }
}

// ─── Directory-input fallback (works in Firefox/Safari/all major browsers) ──
function bindFilePicker() {
  document.getElementById('btnPickFiles').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    // Filter to audit-log.jsonl files only — webkitdirectory pulls everything
    // in the picked tree, including node_modules / .git / etc.
    const audit = files.filter((f) => {
      const path = f.webkitRelativePath || f.name;
      return path.endsWith('/.toolcairn/audit-log.jsonl') || path.endsWith('\\\\.toolcairn\\\\audit-log.jsonl') || (f.name === 'audit-log.jsonl' && path.includes('.toolcairn'));
    });
    if (audit.length === 0) {
      alert('No .toolcairn/audit-log.jsonl files found in the picked folder.');
      return;
    }
    state.sources = audit.map((f) => ({
      rootName: deriveRootFromPath(f.webkitRelativePath || f.name),
      file: f,
      lastSize: 0,
    }));
    state.entries = [];
    state.seenKeys = new Set();
    showDashboard();
    await pollAll();
    // Note: re-reading a File picked via <input> doesn't pick up new bytes
    // until the user re-picks. Polling is a no-op for this fallback.
  });
}

/**
 * Pull the project-root name from a path like
 *   "ToolPilot/toolcairn-engine/.toolcairn/audit-log.jsonl"
 * → "toolcairn-engine"
 *
 * If \`.toolcairn\` is at the picked-folder root (single project), the root
 * name is the picked folder itself.
 */
function deriveRootFromPath(path) {
  const segs = path.split(/[\\\\/]/).filter(Boolean);
  const idx = segs.lastIndexOf('.toolcairn');
  if (idx <= 0) return segs[0] || 'root';
  return segs[idx - 1];
}

// ─── Reading ────────────────────────────────────────────────────────────────
async function pollAll() {
  let added = 0;
  for (const src of state.sources) {
    try {
      const text = await readSource(src);
      if (text == null) continue;
      added += ingestText(text, src.rootName);
    } catch { /* swallow per-file */ }
  }
  if (added > 0 || state.entries.length === 0) renderAll();
  document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
  updateStatusDot();
}

async function readSource(src) {
  if (src.fileHandle) {
    const file = await src.fileHandle.getFile();
    if (file.size === src.lastSize) return null;
    src.lastSize = file.size;
    return await file.text();
  }
  if (src.file) {
    if (src.file.size === src.lastSize) return null;
    src.lastSize = src.file.size;
    return await src.file.text();
  }
  return null;
}

function ingestText(text, rootName) {
  let added = 0;
  for (const line of text.split('\\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const key = rootName + '::' + parsed.timestamp + '::' + parsed.action + '::' + (parsed.tool ?? '') + '::' + (parsed.mcp_tool ?? '') + '::' + (parsed.query_id ?? '');
    if (state.seenKeys.has(key)) continue;
    state.seenKeys.add(key);
    state.entries.push({ ...parsed, _root: rootName, _key: key });
    added++;
  }
  if (added > 0) {
    state.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
  return added;
}

function startPolling() {
  stopPolling();
  if (!state.isLive) return;
  state.pollHandle = setInterval(pollAll, state.pollMs);
}
function stopPolling() {
  if (state.pollHandle) { clearInterval(state.pollHandle); state.pollHandle = null; }
}

function updateStatusDot() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (state.sources.length === 0) {
    dot.className = 'status-dot';
    txt.textContent = 'No folder selected';
    return;
  }
  if (state.isLive) {
    dot.className = 'status-dot live';
    txt.textContent = state.sources.length + ' file' + (state.sources.length === 1 ? '' : 's') + ' · ' + state.entries.length + ' entries';
  } else {
    dot.className = 'status-dot paused';
    txt.textContent = 'Paused · ' + state.entries.length + ' entries';
  }
}

// ─── Filtering ──────────────────────────────────────────────────────────────
function filteredEntries() {
  return state.entries.filter((e) => {
    if (state.rootFilter && e._root !== state.rootFilter) return false;
    if (state.textFilter) {
      const q = state.textFilter.toLowerCase();
      const hay = (e.action + ' ' + (e.mcp_tool ?? '') + ' ' + (e.tool ?? '') + ' ' + (e.query_id ?? '') + ' ' + (e.reason ?? '') + ' ' + JSON.stringify(e.metadata ?? {})).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFeed() {
  const feed = document.getElementById('feed');
  const empty = document.getElementById('feedEmpty');
  const list = filteredEntries();
  feed.querySelectorAll('.event-row').forEach((r) => r.remove());
  if (list.length === 0) {
    empty.style.display = 'block';
    return;
  }
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
      '<span class="root" title="' + escapeHtml(e._root) + '">' + escapeHtml(e._root) + '</span>' +
      '<span class="tool" title="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</span>' +
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
    return e.reason ?? '';
  }
  if (e.action === 'mark_suggestions_sent') {
    const m = e.metadata;
    return ((m?.tool_count) ?? 0) + ' tools staged: ' + ((m?.tool_names) || []).slice(0, 3).join(', ');
  }
  if (e.action === 'add_tool' || e.action === 'remove_tool' || e.action === 'update_tool' || e.action === 'add_evaluation') {
    return e.tool + (e.metadata?.version ? (' @ ' + e.metadata.version) : '');
  }
  return e.reason ?? '';
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
  // Mirrors packages/tools-local/src/handlers/read-project-config.ts:derivePendingOutcomes
  const cutoff = Date.now() - PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;
  const open = new Map();
  // Walk entries oldest-first so report_outcomes correctly delete prior search entries.
  const chrono = [...state.entries].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const e of chrono) {
    if (e.action !== 'tool_call' || !e.query_id) continue;
    if (e.status === 'error') continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    if (RECOMMENDATION_TOOLS.has(e.mcp_tool)) {
      const queryFromMeta = e.metadata?.query ?? e.metadata?.use_case ?? null;
      open.set(e._root + '::' + e.query_id, {
        root: e._root,
        query_id: e.query_id,
        mcp_tool: e.mcp_tool,
        selected_at: e.timestamp,
        age_hours: Math.round((Date.now() - ts) / (1000 * 60 * 60)),
        candidates: e.candidates ?? [],
        query: queryFromMeta,
      });
    } else if (e.mcp_tool === 'report_outcome') {
      open.delete(e._root + '::' + e.query_id);
    }
  }
  return Array.from(open.values()).sort((a, b) => new Date(a.selected_at) - new Date(b.selected_at));
}

function renderPending() {
  const list = derivePending();
  const root = document.getElementById('pendingList');
  if (list.length === 0) {
    root.innerHTML = '<div style="color:var(--muted);font-size:12px;">All recommendations have outcomes 🎉</div>';
    return;
  }
  root.innerHTML = list.slice(0, 12).map((p) =>
    '<div class="pending-item">' +
      '<div class="pi-tool">' + escapeHtml(p.mcp_tool) + ' · ' + escapeHtml(p.root) + '</div>' +
      '<div class="pi-meta">query_id ' + escapeHtml(p.query_id.slice(0, 12)) + ' · ' + p.age_hours + 'h ago' +
        (p.query ? (' · "' + escapeHtml(p.query.slice(0, 60)) + '"') : '') +
      '</div>' +
      (p.candidates.length > 0 ? ('<div class="pi-cands">' + escapeHtml(p.candidates.slice(0, 4).join(' · ')) + '</div>') : '') +
    '</div>'
  ).join('');
}

function renderRoots() {
  const counts = new Map();
  for (const e of state.entries) counts.set(e._root, (counts.get(e._root) ?? 0) + 1);
  const list = document.getElementById('rootList');
  list.innerHTML = '';
  const allTag = document.createElement('span');
  allTag.className = 'root-tag' + (state.rootFilter == null ? ' active' : '');
  allTag.innerHTML = 'all<span class="count">' + state.entries.length + '</span>';
  allTag.onclick = () => { state.rootFilter = null; renderAll(); };
  list.appendChild(allTag);
  for (const [root, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = document.createElement('span');
    const isActive = state.rootFilter === root;
    tag.className = 'root-tag' + (isActive ? ' active' : (state.rootFilter !== null ? ' disabled' : ''));
    tag.innerHTML = escapeHtml(root) + '<span class="count">' + count + '</span>';
    tag.onclick = () => { state.rootFilter = isActive ? null : root; renderAll(); };
    list.appendChild(tag);
  }
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
  const e = state.entries.find((x) => x._key === state.selectedKey);
  if (!e) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const rows = [
    ['Project root', e._root],
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
  renderRoots();
  renderMetrics();
  renderFeed();
  renderToolChart();
  renderActionChart();
  renderPending();
  renderDetail();
  updateStatusDot();
}

// ─── UI bindings ────────────────────────────────────────────────────────────
function showDashboard() {
  document.getElementById('pickerBanner').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
}
function showPicker() {
  document.getElementById('pickerBanner').style.display = 'block';
  document.getElementById('dashboard').style.display = 'none';
  stopPolling();
  state.sources = [];
  state.entries = [];
  state.seenKeys = new Set();
  state.selectedKey = null;
  updateStatusDot();
}

document.getElementById('btnPickDir').addEventListener('click', pickDirectory);
document.getElementById('btnRefresh').addEventListener('click', pollAll);
document.getElementById('btnLive').addEventListener('click', () => {
  state.isLive = !state.isLive;
  document.getElementById('btnLive').classList.toggle('active', state.isLive);
  if (state.isLive) startPolling(); else stopPolling();
  updateStatusDot();
});
document.getElementById('intervalSlider').addEventListener('input', (e) => {
  state.pollMs = Number(e.target.value) * 1000;
  document.getElementById('intervalLabel').textContent = e.target.value + 's';
  if (state.isLive) startPolling();
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
document.getElementById('btnReset').addEventListener('click', showPicker);

bindDropZone();
bindFilePicker();

if (!state.hasFsa) {
  document.getElementById('btnPickDir').textContent = 'Folder picker unavailable — use file picker';
  document.getElementById('btnPickDir').disabled = true;
}
</script>

</body>
</html>
`;
}

// app.js — fleet observatory: agent list + live "watch it think" stream + steer.
'use strict';

const $ = sel => document.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
// NAMED-CONTEXT picker: pick a daemon by NAME; the port mapping stays hidden here and is
// never shown in the UI. PORT() stays a global (timetape.js reads it) — only its source moved.
const CTX_PORTS = { fleet: 7978, board: 7977, code: 7979, attention: 7980 };
const ctxEl = $('#context');
const CTX = () => (ctxEl && ctxEl.value) || 'fleet';
const CTX_NAME = () => ctxEl ? ctxEl.options[ctxEl.selectedIndex].text : 'Fleet';
const PORT = () => CTX_PORTS[CTX()] || 7978;

let selected = null;        // selected agent uuid
let streamWS = null;        // live activity WebSocket
let liveWS = null;          // daemon commit feed WebSocket
let tokens = { in: 0, out: 0 };
const agentsById = {};      // uuid → last presence record (for cross-tab selection)

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  showTab(t.dataset.view);
  // defer to next frame: #cy is display:none until showTab paints .active, so a
  // synchronous ensure() lets cytoscape fit against a 0×0 container → squished nodes.
  if (t.dataset.view === 'graph') requestAnimationFrame(() => Graph.ensure());
});

// ---------- graph-membership facet: toggle source daemons in the one union ----------
const GRAPH_FACETS = [
  ['fleet', 'fleet'], ['code', 'code'], ['board', 'board'], ['work', 'working'], ['attention', 'attention'],
];
function renderGraphFacets() {
  const bar = document.getElementById('graph-facets');
  if (!bar || bar.dataset.built) return;
  const vis = Graph.getGraphVisible();
  GRAPH_FACETS.forEach(([key, label]) => {
    const b = el('button', 'facet-chip g-' + key + (vis[key] === false ? '' : ' on'), label);
    b.dataset.graph = key;
    b.onclick = () => {
      const now = !b.classList.contains('on');
      b.classList.toggle('on', now);
      Graph.setGraphFilter(key, now);
    };
    bar.append(b);
  });
  bar.dataset.built = '1';
}
renderGraphFacets();
function syncGraphFacets() {
  const vis = Graph.getGraphVisible();
  document.querySelectorAll('#graph-facets .facet-chip').forEach(b =>
    b.classList.toggle('on', vis[b.dataset.graph] !== false));
}

// ---------- graph mode: backbone (default) ↔ raw atoms ----------
document.querySelectorAll('#graph-mode button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#graph-mode button').forEach(x => x.classList.toggle('on', x === b));
  Graph.setMode(b.dataset.mode);
});

// ---------- view engine (9d7d): layout · size-by · edge-layers · recency · presets ----------
// reflect engine state back onto the controls (a preset can change all of them at once).
function syncGraphControls() {
  const s = Graph.getState();
  document.querySelectorAll('#graph-mode button').forEach(x => x.classList.toggle('on', x.dataset.mode === s.mode));
  document.querySelectorAll('#graph-layout button').forEach(x => x.classList.toggle('on', x.dataset.layout === s.layout));
  const sb = $('#size-by'); if (sb) sb.value = s.size;
  document.querySelectorAll('#edge-layers input').forEach(c => c.checked = s.edgeLayers[c.dataset.layer] !== false);
  const rs = $('#recency-slider'), rv = $('#recency-val');
  if (rs) rs.value = String(s.recencyMax);
  if (rv) rv.textContent = s.recencyMax >= 120 ? 'all' : s.recencyMax + 'm';
  const iso = $('#isolates-toggle'); if (iso) iso.classList.toggle('on', !s.hideIsolates);
  const lb = $('#lightshow-toggle'); if (lb) lb.classList.toggle('on', !!s.lightShow);
  syncGraphFacets();
}

// layout selector
document.querySelectorAll('#graph-layout button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#graph-layout button').forEach(x => x.classList.toggle('on', x === b));
  Graph.setLayout(b.dataset.layout);
});
// 2D ⇄ 3D projection toggle — layout selector is 2D-only, so dim it in 3D.
document.querySelectorAll('#graph-dim button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#graph-dim button').forEach(x => x.classList.toggle('on', x === b));
  Graph.setDim(b.dataset.dim);
  document.getElementById('graph-layout').classList.toggle('disabled', b.dataset.dim === '3d');
});
// keep the WebGL canvas matched to its container (cytoscape self-resizes; three doesn't).
window.addEventListener('resize', () => {
  if (Graph.getDim() === '3d' && window.Graph3D && Graph3D.isMounted()) Graph3D.resize();
});
// size-by channel
const sizeBy = $('#size-by');
if (sizeBy) sizeBy.onchange = () => Graph.setSizeChannel(sizeBy.value);
// edge-layer toggles
document.querySelectorAll('#edge-layers input').forEach(c =>
  c.onchange = () => Graph.setEdgeLayer(c.dataset.layer, c.checked));
// recency filter
const recencySlider = $('#recency-slider');
if (recencySlider) {
  const rv = $('#recency-val');
  const show = v => { if (rv) rv.textContent = (+v >= 120) ? 'all' : v + 'm'; };
  recencySlider.oninput = () => show(recencySlider.value);
  recencySlider.onchange = () => Graph.setRecencyMax(recencySlider.value);
}

// presets: built-in + saved view chips; ＋ Save view captures the current state.
function renderPresets() {
  const bar = $('#preset-bar'); if (!bar) return;
  bar.innerHTML = '';
  const { builtin, user } = Graph.listPresets();
  builtin.forEach(name => bar.append(presetChip(name, false)));
  user.forEach(name => bar.append(presetChip(name, true)));
}
function presetChip(name, deletable) {
  const chip = el('span', 'preset-chip' + (deletable ? ' user' : ''));
  const lbl = el('button', 'preset-name', name);
  lbl.onclick = () => { Graph.applyPreset(name); syncGraphControls(); closeDropdowns(null); };
  chip.append(lbl);
  if (deletable) {
    const x = el('button', 'preset-del', '✕');
    x.onclick = e => { e.stopPropagation(); Graph.deletePreset(name); renderPresets(); };
    chip.append(x);
  }
  return chip;
}
const presetSave = $('#preset-save');
if (presetSave) presetSave.onclick = () => {
  const name = prompt('Save current view as preset:');
  if (name && Graph.savePreset(name)) renderPresets();
};
renderPresets();

// AST collapse depth (code snapshots only; control auto-shows when one loads).
const depthSlider = $('#depth-slider');
if (depthSlider) {
  const out = $('#depth-val');
  depthSlider.oninput = () => { if (out) out.textContent = depthSlider.value; };
  depthSlider.onchange = () => Graph.setDepth(depthSlider.value);
}
// manual Re-layout — auto-layout stays frozen during live updates so the graph
// holds still while Tom manipulates it; this forces a fresh arrange on demand.
const relayoutBtn = $('#graph-relayout');
if (relayoutBtn) relayoutBtn.onclick = () => Graph.relayout();

// de-blob: toggle the disconnected 0-degree dot-grid in/out. `on` == isolates shown.
const isoBtn = $('#isolates-toggle');
if (isoBtn) isoBtn.onclick = () => { const show = !isoBtn.classList.contains('on'); isoBtn.classList.toggle('on', show); Graph.setHideIsolates(!show); };

// ---------- control surface (573b): draw-to-assign buttons mirror the hotkeys ----------
document.querySelectorAll('#graph-edit button').forEach(b =>
  b.onclick = () => Graph.startLink(b.dataset.link));
const newWorkBtn = $('#graph-newwork');
if (newWorkBtn) newWorkBtn.onclick = () => Graph.createWork();

// ⚙ More — collapse the advanced controls so the column stays short (F-1).
const moreBtn = $('#gc-more'), drawer = $('#gc-drawer');
if (moreBtn && drawer) moreBtn.onclick = () => {
  const open = !drawer.classList.toggle('collapsed');
  moreBtn.classList.toggle('on', open);
  moreBtn.setAttribute('aria-expanded', String(open));
};

// ---------- dropdown buttons (2-row toolbar c78a/54be): Views + Graphs ----------
// presets and source-graphs fold into popover menus so the toolbar holds to two rows.
// Only one menu open at a time; a click anywhere outside closes them.
const DROPDOWNS = [['#preset-dd-btn', '#preset-dd'], ['#graphs-dd-btn', '#graphs-dd']];
function closeDropdowns(except) {
  DROPDOWNS.forEach(([, dd]) => { const el = $(dd); if (el && dd !== except) { el.classList.remove('open'); const b = el.querySelector('.dd-btn'); if (b) b.setAttribute('aria-expanded', 'false'); } });
}
DROPDOWNS.forEach(([btnSel, ddSel]) => {
  const btn = $(btnSel), dd = $(ddSel);
  if (!btn || !dd) return;
  btn.onclick = e => {
    e.stopPropagation();
    const open = !dd.classList.contains('open');
    closeDropdowns(open ? ddSel : null);
    dd.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  dd.querySelector('.gc-menu').addEventListener('click', e => e.stopPropagation());
});
document.addEventListener('click', () => closeDropdowns(null));

// 🔦 dark-room: dim everything but the live attention beams (light-show item 4).
const lightBtn = $('#lightshow-toggle');
if (lightBtn) lightBtn.onclick = () => { const on = !Graph.getLightShow(); Graph.setLightShow(on); lightBtn.classList.toggle('on', on); };

// ---------- omni-search + status filter (agent list) ----------
// both narrow the same list; fold them into the one styled hide class (.agent.hide-search).
let omniQuery = '';
let statusFilter = 'all';   // all | working | dormant | offline
function statusOf(a) { return !a.online ? 'offline' : (isWorking(a) ? 'working' : 'dormant'); }
function applyAgentFilter() {
  document.querySelectorAll('#agent-list .agent').forEach(li => {
    const hay = (li.textContent + ' ' + (li.dataset.uuid || '')).toLowerCase();
    const hitSearch = !omniQuery || hay.includes(omniQuery);
    const hitStatus = statusFilter === 'all'
      || (statusFilter === 'pinned' ? li.dataset.pinned === 'true' : li.dataset.status === statusFilter);
    li.classList.toggle('hide-search', !(hitSearch && hitStatus));
  });
}
function fmtAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const h = ms / 3600000;
  if (h < 1) return Math.round(h * 60) + 'm ago';
  if (h < 24) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
const STALE_COLORS = { GREEN: '#4a4', YELLOW: '#ca0', RED: '#c44', PINNED: '#58f' };
$('#omni').addEventListener('input', e => {
  omniQuery = e.target.value.trim().toLowerCase();
  Graph.search(omniQuery);
  applyAgentFilter();
});
document.querySelectorAll('#agent-filter button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#agent-filter button').forEach(x => x.classList.toggle('on', x === b));
  statusFilter = b.dataset.status;
  applyAgentFilter();
});

// ---------- connection status ----------
function setStatus(ok, label) {
  $('#status').className = 'dot ' + (ok ? 'on' : 'off');
  $('#status-label').textContent = label;
}

// ---------- presence (agent list) ----------
async function refreshPresence() {
  try {
    const r = await fetch(`/presence?port=${PORT()}`);
    const agents = await r.json();
    const working = agents.filter(isWorking).length;
    const ready = agents.filter(a => a.online && !isWorking(a)).length;
    // "online" alone read as "working"; split it: working=burning tokens now, ready=dormant-but-reachable.
    setStatus(true, `${working} working · ${ready} ready · ${CTX_NAME()}`);
    renderAgents(agents);
  } catch (e) {
    setStatus(false, 'bridge unreachable');
  }
}

// "working" = its activity stream wrote within the last ~30s; else dormant.
function isWorking(a) { return a.stream_age_s != null && a.stream_age_s < 30; }
function fmtUsd(c) { const n = Number(c) || 0; return '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2)); }

function renderAgents(agents) {
  const list = $('#agent-list');
  $('#agent-count').textContent = agents.length;
  list.innerHTML = '';
  for (const a of agents) {
    agentsById[a.uuid] = a;
    const working = isWorking(a);
    const li = el('li', 'agent' + (a.online ? '' : ' offline') + (a.uuid === selected ? ' sel' : ''));
    li.dataset.uuid = a.uuid;
    li.dataset.status = statusOf(a);   // for the All/Working/Dormant/Offline filter
    li.dataset.pinned = a.pinned ? 'true' : 'false';
    if (working) li.classList.add('working');
    if (a.pinned) li.classList.add('pinned');
    li.title = 'watch this agent — open live stream';

    // row1: staleness dot · status badge · primary label (role) · pin · gen · age
    const row1 = el('div', 'row1');
    const bucket = a.staleness_bucket || 'GREEN';
    const dot = el('span', 'stale-dot');
    dot.style.background = STALE_COLORS[bucket] || '#888';
    dot.title = bucket + ' (' + (a.staleness_score != null ? a.staleness_score.toFixed(2) : '?') + ')';
    const status = el('span', 'status ' + (working ? 'work' : a.online ? 'idle' : 'off'),
      working ? '● working' : a.online ? '○ dormant' : '· offline');
    const name = el('span', 'aname', a.roles[0] || a.uuid.slice(0, 8));
    row1.append(dot, status, name);
    if (a.pinned) row1.append(el('span', 'pin-badge', '📌'));
    if (a.generation > 0) row1.append(el('span', 'gen-badge', 'G' + a.generation));
    const age = fmtAge(a.spawned_at);
    if (age) row1.append(el('span', 'age-chip', age));
    if (a.needs_you) row1.append(el('span', 'needs-you', '⚑ needs you'));
    li.append(row1);

    // role chips
    if (a.roles.length > 1 || !a.roles.length) {
      const roles = el('div', 'roles');
      (a.roles.length ? a.roles : ['no role']).forEach(rname =>
        roles.append(el('span', 'chip' + (a.roles.length ? '' : ' muted'), rname)));
      li.append(roles);
    }

    // meta row: uuid · model · cost-so-far
    const meta = el('div', 'meta');
    meta.append(el('span', 'uuid', a.uuid.slice(0, 8)));
    if (a.model) meta.append(el('span', 'mchip', a.model + (a.effort ? '·' + a.effort : '')));
    if (a.cost_usd) meta.append(el('span', 'cost-chip', fmtUsd(a.cost_usd)));
    li.append(meta);

    // current focus
    const focusTxt = a.active_workflow || a.current_thread || a.task;
    if (focusTxt) {
      const f = el('div', 'focus');
      // "↳ doing" marker — informational, not a play control. (The play-triangle ▸ here read
      // as a clickable button but did nothing; the whole card already opens the live stream.)
      f.append(el('span', 'focus-mark', '↳'));
      f.append(el('span', a.active_workflow ? 'wf' : '', focusTxt));
      li.append(f);
    }

    li.onclick = () => selectAgent(a);
    list.append(li);
  }
  applyAgentFilter();
}

// ---------- live activity stream ----------
function selectAgent(a) {
  selected = a.uuid;
  document.querySelectorAll('.agent').forEach(x => x.classList.toggle('sel', x.dataset.uuid === a.uuid));
  $('#stream-title').textContent = `@agent:${a.uuid.slice(0, 12)}  ${a.roles.map(r => '['+r+']').join(' ')}`;
  $('#steer-to').value = a.roles[0] || a.uuid;
  tokens = { in: 0, out: 0 };
  updateCost();
  const stream = $('#stream');
  stream.innerHTML = '';
  if (!a.has_stream) { stream.append(el('div', 'empty', 'No activity stream for this agent (never ran on the streaming runner).')); }
  openStream(a.uuid);
  // if the Decisions view is the active detail, re-point it at the new agent.
  if (detailView === 'decisions' && window.mountDecisions) mountDecisions($('#decisions'), a.uuid);
  // shared selection: mirror onto the graph if it's loaded.
  if (window.Graph && Graph.focus) Graph.focus('@agent:' + a.uuid);
}

// ---------- agent-detail view switch: live Stream ⇄ Decisions (window.mountDecisions) ----
let detailView = 'stream';
function showDetail(which) {
  detailView = which;
  document.querySelectorAll('#detail-view button').forEach(b => b.classList.toggle('on', b.dataset.detail === which));
  const onStream = which === 'stream';
  // no generic .hidden rule in the stylesheet → toggle display inline (style.css is owned elsewhere).
  $('#stream').style.display = onStream ? '' : 'none';
  $('#steer-form').style.display = onStream ? '' : 'none';
  $('#decisions').style.display = onStream ? 'none' : '';
  if (!onStream && selected && window.mountDecisions) mountDecisions($('#decisions'), selected);
}
document.querySelectorAll('#detail-view button').forEach(b => b.onclick = () => showDetail(b.dataset.detail));

// ---------- unify hook: graph agent-node → live stream (shared selection) ----
const VIEW_EL = { observatory: 'observatory', board: 'board-view', graph: 'graph-view' };
let boardMounted = false;
function showTab(view) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#' + (VIEW_EL[view] || 'observatory')).classList.add('active');
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
  // wire-in: the Board view is owned by the board module — mount once on first open.
  if (view === 'board' && window.mountBoard && !boardMounted) { mountBoard($('#board-root')); boardMounted = true; }
}
// deep-link: #graph / #board open that tab on load (shareable + lets QA target it directly).
if (location.hash === '#graph') { showTab('graph'); requestAnimationFrame(() => Graph.ensure()); }
else if (location.hash === '#board') { showTab('board'); }
window.FrameScope = {
  openAgentStream(handle) {
    showTab('observatory');
    const a = agentsById[handle] || { uuid: handle, roles: [], has_stream: true };
    selectAgent(a);
    const li = document.querySelector(`#agent-list .agent[data-uuid="${handle}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }
};

// Board card → thread detail in the graph PROPERTIES pane. focus() is the cross-tab
// entry point (centers + selects + opens #node-panel); the federated graph loads async
// on first open, so retry until the node lands (or give up after ~4s).
window.selectNode = function (id) {
  showTab('graph');
  Graph.ensure();
  let tries = 0;
  (function tryFocus() {
    if (Graph.focus(id) || ++tries > 40) return;
    setTimeout(tryFocus, 100);
  })();
};

function openStream(uuid) {
  if (streamWS) { try { streamWS.close(); } catch (e) {} streamWS = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/stream?uuid=${encodeURIComponent(uuid)}`);
  streamWS = ws;
  ws.onmessage = ev => {
    if (uuid !== selected) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error') { $('#stream').append(sysLine('stream: ' + msg.error)); return; }
    if (msg.type !== 'line') return;
    let e; try { e = JSON.parse(msg.raw); } catch (_) { return; }
    renderEvent(e);
  };
  ws.onerror = () => {};
}

const atBottom = () => { const s = $('#stream'); return s.scrollHeight - s.scrollTop - s.clientHeight < 80; };
function push(node) {
  const s = $('#stream');
  const stick = atBottom();
  s.append(node);
  if (stick) s.scrollTop = s.scrollHeight;
}
function sysLine(txt) { return el('div', 'ev sys', txt); }

function block(kind, label, bodyText, opts = {}) {
  const e = el('div', 'ev ' + kind + (opts.err ? ' err' : ''));
  if (label) e.append(el('div', 'label', label));
  if (opts.pre) { const pre = el('pre'); pre.textContent = bodyText; e.append(pre); }
  else {
    const b = el('div', 'body');
    // prose (assistant text / thinking) → markdown if the module is loaded; it owns sanitization.
    if (window.renderMarkdown) b.innerHTML = renderMarkdown(bodyText);
    else b.textContent = bodyText;
    e.append(b);
  }
  return e;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : (c.text || c.content || JSON.stringify(c))).join('\n');
  return JSON.stringify(content);
}

function renderEvent(e) {
  const t = e.type;
  if (t === 'assistant' || t === 'user') {
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) push(block('text', 'assistant', b.text));
      else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) push(block('thinking', 'thinking', b.thinking));
      else if (b.type === 'tool_use') {
        const card = el('div', 'ev tool');
        const head = el('div'); head.append(el('span', 'name', b.name || 'tool'));
        card.append(head);
        const pre = el('pre'); pre.textContent = JSON.stringify(b.input || {}, null, 2); card.append(pre);
        push(card);
      } else if (b.type === 'tool_result') {
        push(block('result', 'result', clip(textOf(b.content), 4000), { pre: true, err: b.is_error }));
      }
    }
    if (e.message && e.message.usage) {
      const u = e.message.usage;
      tokens.in += (u.input_tokens || 0); tokens.out += (u.output_tokens || 0);
      updateCost();
    }
  } else if (t === 'system') {
    if (e.subtype === 'init') push(sysLine('● session started'));
    else if (e.subtype === 'task_notification') push(sysLine('✦ ' + (e.message || 'task notification')));
    // thinking_tokens / hook_* are noise — skip
  } else if (t === 'rate_limit_event') {
    push(sysLine('⏳ rate limit event'));
  }
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s; }
function updateCost() {
  $('#stream-cost').textContent = (tokens.in || tokens.out)
    ? `↑${fmt(tokens.in)} ↓${fmt(tokens.out)} tok` : '';
}
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n; }

// ---------- steer ----------
$('#steer-form').onsubmit = async ev => {
  ev.preventDefault();
  const to = $('#steer-to').value.trim();
  const body = $('#steer-body').value.trim();
  if (!to || !body) return;
  const btn = $('#steer-form button'); btn.disabled = true;
  try {
    const r = await fetch('/steer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: PORT(), to, body })
    });
    const res = await r.json();
    push(sysLine(res.ok ? `→ steered ${to}: "${clip(body, 80)}"` : `steer failed: ${res.out}`));
    if (res.ok) $('#steer-body').value = '';
  } catch (e) { push(sysLine('steer error: ' + e.message)); }
  btn.disabled = false;
};

// ---------- live commit feed (drives graph + presence refresh) ----------
function openLive() {
  if (liveWS) { try { liveWS.close(); } catch (e) {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/live?port=${PORT()}`);
  liveWS = ws;
  let pending = false;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type !== 'commit') return;
    Graph.onCommit(m);
    TimeTape.onCommit(m);
    // a presence-relevant change → debounce a refresh
    if (['holds', 'lease', 'current_thread', 'active_workflow', 'lifecycle'].includes(m.p) && !pending) {
      pending = true; setTimeout(() => { pending = false; refreshPresence(); }, 400);
    }
  };
  ws.onclose = () => setTimeout(openLive, 2000);
}

// ---------- boot ----------
if (ctxEl) ctxEl.onchange = () => { refreshPresence(); openLive(); Graph.reset(); TimeTape.refresh(); };
refreshPresence();
setInterval(refreshPresence, 4000);
openLive();
TimeTape.init();

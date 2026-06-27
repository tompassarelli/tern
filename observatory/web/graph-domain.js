// graph-domain.js — the PURE claims→graph transform layer.
//
// This is the beagle-js dogfood candidate (BRIEF "Beagle dogfood"): pure, typed,
// total functions with no DOM/WS/IO. Authored in plain JS for a runnable v1; the
// intent is to port THIS file to beagle-js (compile→JS) once the observatory ships.
// Everything here is data-driven — no hardcoded agent/msg/role knowledge — so the
// v2 code-as-claims graph reuses it unchanged.

(function (global) {
  'use strict';

  // node TYPE = the id prefix. "@agent:x"→"agent", "@2026-..."→"thread", else "node".
  function nodeType(id) {
    const body = id.charAt(0) === '@' ? id.slice(1) : id;
    const c = body.indexOf(':');
    if (c > 0) return body.slice(0, c);
    if (/^\d{4}-\d{2}-\d{2}/.test(body)) return 'thread';
    return 'node';
  }

  // short, human label for a node id (id-only fallback).
  function shortLabel(id) {
    const body = id.charAt(0) === '@' ? id.slice(1) : id;
    const c = body.indexOf(':');
    const rest = c > 0 ? body.slice(c + 1) : body;
    // uuids / long hex / long ids → first 8 chars
    return rest.length > 14 ? rest.slice(0, 8) : rest;
  }

  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function fmtUsd(c) { const n = Number(c); return isFinite(n) ? '$' + n.toFixed(n < 1 ? 3 : 2) : String(c); }

  // best-effort timestamp → epoch ms. Accepts epoch sec/ms (number or numeric
  // string) and ISO strings. Returns 0 when nothing parses (treated as "no
  // activity" by the recency filter, not "now").
  function toEpoch(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) { const n = +s; return n < 1e12 ? n * 1000 : n; }
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }
  // the freshest activity timestamp on a raw node's attrs (msg sent, run end, etc).
  const TIME_ATTRS = ['sent_at', 'ended_at', 'started_at', 'attending_at', 'ts', 'updated_at', 'created_at'];
  function nodeTime(attrs) {
    attrs = attrs || {};
    let best = 0;
    for (const k of TIME_ATTRS) { const t = toEpoch(attrs[k]); if (t > best) best = t; }
    return best;
  }

  // TYPED + LABELED atom: resolve a HUMAN label per node type, not a raw id.
  // Every claim-subject becomes a labeled node — message=its subject, agent=its
  // role, run=its cost, thread=its title, session=its agent. `ctx.role` is the
  // agent's held-role slug (derived from its `holds @role:*` edge in toCyElements).
  function labelFor(id, type, attrs, ctx) {
    attrs = attrs || {}; ctx = ctx || {};
    const short = shortLabel(id);
    switch (type) {
      case 'msg':     return clip(attrs.subject || attrs.body || short, 30);
      case 'agent':   return ctx.role || short;
      case 'role':    return short;
      case 'run':     return attrs.cost_usd != null ? fmtUsd(attrs.cost_usd) : short;
      case 'session': return clip(attrs.agent || short, 18);
      case 'thread':  return clip(attrs.title || short, 30);
      case 'lease':   return short;
      // a cursor: tool glyph + touched file, so a glance reads "who looks, how, AT WHAT".
      // attending_file is often an ABSOLUTE path (fram-engine §9) → basename it; no file → uuid.
      case 'attention': return (attrs.attending_tool === 'Edit' || attrs.attending_tool === 'Write' ||
                                attrs.attending_tool === 'MultiEdit' ? '✎ ' : '◉ ') +
                               (attrs.attending_file ? basename(attrs.attending_file) : short);
      default:        return clip(attrs.title || attrs.subject || short, 24);
    }
  }

  // Stable color from a type string — golden-angle hue rotation keyed on a hash,
  // so the palette is deterministic but spreads distinct types far apart in hue.
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function colorForType(type) {
    // attention cursors are the light-show's stars — a fixed hot cyan-white so they
    // read as "live focus", not just another hashed hue.
    if (type === 'attention') return 'hsl(180, 90%, 70%)';
    const hue = (hashStr(type) % 360);
    // comma-separated, NOT CSS Color-4 space syntax: cytoscape's color parser
    // only matches hsl(h, s%, l%) — space form silently fails → default gray node.
    return `hsl(${hue}, 70%, 62%)`;
  }

  // edge KIND from predicate: the light-show's `attending` (agent cursor → module) is
  // its own glowing layer, distinct from struct/talk/child. Everything else keeps its
  // bridge-supplied kind (working/…) or defaults to struct. Keyed here, in the pure
  // layer, so BOTH raw + backbone transforms and the 3D projection classify it alike.
  function edgeKind(pred, rawKind) {
    if (pred === 'attending') return 'attending';
    return rawKind || 'struct';
  }

  // Build {nodes, edges, types} for the renderer from a bridge snapshot.
  // Input snapshot: {nodes:[{id,type,attrs}], edges:[{from,pred,to}]}.
  function toCyElements(snapshot) {
    // derive per-node ctx (an agent's held-role slug) from the edge set first,
    // so labelFor can label an @agent by the role it holds.
    const ctx = {};
    snapshot.edges.forEach(e => {
      if (e.pred === 'holds' && typeof e.to === 'string' && e.to.startsWith('@role:'))
        (ctx[e.from] = ctx[e.from] || {}).role = e.to.slice('@role:'.length);
    });
    const typeSet = new Set();
    const nodes = snapshot.nodes.map(n => {
      const type = n.type || nodeType(n.id);
      const attrs = n.attrs || {};
      typeSet.add(type);
      // `graph` = source-daemon membership (agents/code/board/work) — a filter facet.
      return { data: { id: n.id, label: labelFor(n.id, type, attrs, ctx[n.id]), type, attrs,
                       graph: n.graph || 'agents' } };
    });
    // stamp lastActive so the recency filter + size-by:recency channel work in raw mode too.
    nodes.forEach(n => { n.data.lastActive = nodeTime(n.data.attrs); });
    const edges = snapshot.edges.map((e, i) => ({
      data: { id: 'e' + i, source: e.from, target: e.to, pred: e.pred,
              kind: edgeKind(e.pred, e.kind), graph: e.graph }
    }));
    const types = [...typeSet].sort().map(t => ({ type: t, color: colorForType(t) }));
    return { nodes, edges, types };
  }

  // ---- BACKBONE view: de-blob the firehose ----------------------------------
  // A graph of 130 message-dots is confetti, not structure. The backbone keeps
  // only the structural nodes (@agent/@role/@thread) and collapses every @msg into
  // WEIGHTED who-talks-to-whom edges between the parties. Messages stop being nodes
  // and become DRILL-DOWN: each party-node / talk-edge carries the messages behind
  // it for the detail pane. `@run` cost is rolled up onto the agent it ran as.
  // backbone-only + aggregate edges.
  // `work` survives the de-blob too: a control-surface work node is first-class
  // structure (it gets a driver/depends_on), not collapsible firehose like @msg. (573b)
  const STRUCTURAL = new Set(['agent', 'role', 'thread', 'work']);

  // resolve a msg from/to string to a canonical party-node id. The "@party:" type is
  // RETIRED (8972): every codename now folds onto a current agent/role instead of
  // spawning a synthetic party. A role slug HELD by an agent merges onto that agent
  // (role-addressed traffic == the agent doing the work); a renamed/unknown handle is
  // treated as an agent handle — never a party.
  function resolveParty(name, roleSlugs, agentHandles, roleHolder) {
    if (name == null || name === '') return null;
    const s = String(name);
    if (s.charAt(0) === '@') return s;                 // already an id
    if (agentHandles.has(s)) return '@agent:' + s;
    if (roleSlugs.has(s)) return (roleHolder && roleHolder[s]) || '@role:' + s;
    return '@agent:' + s;                              // renamed/unknown handle → an agent
  }

  function toBackbone(snapshot) {
    const typeOf = n => n.type || nodeType(n.id);
    const roleSlugs = new Set(), agentHandles = new Set();
    snapshot.nodes.forEach(n => {
      const t = typeOf(n);
      if (t === 'role') roleSlugs.add(n.id.slice('@role:'.length));
      if (t === 'agent') agentHandles.add(n.id.slice('@agent:'.length));
    });

    const nodes = new Map();                           // id -> { data }
    const ctx = {};                                    // agent id -> {role}
    const roleHolder = {};                             // role slug -> holding agent id
    snapshot.edges.forEach(e => {
      if (e.pred === 'holds' && typeof e.to === 'string' && e.to.startsWith('@role:')) {
        const slug = e.to.slice('@role:'.length);
        (ctx[e.from] = ctx[e.from] || {}).role = slug;
        roleHolder[slug] = e.from;                      // so role-addressed traffic merges onto the agent
      }
    });
    function ensure(id, type, attrs) {
      if (!nodes.has(id))
        nodes.set(id, { data: { id, type, attrs: attrs || {}, weight: 0, lastActive: 0,
                                label: labelFor(id, type, attrs || {}, ctx[id]) } });
      return nodes.get(id);
    }
    function touch(id, t) { const n = nodes.get(id); if (n && t > n.data.lastActive) n.data.lastActive = t; }
    // a non-agent graph's nodes must SURVIVE the agent-specific collapse: the backbone
    // de-blobs agent traffic, but the code program / board live in the same union. Keep
    // a code module (the program) so an agent's working_on line lands somewhere visible.
    const isModule = n => n.id.endsWith('#root') || (n.attrs && n.attrs.file) || typeOf(n) === 'module';
    // a beam needs both ends: keep every node an `attending` edge points at, even a bare
    // basename-fallback node (`@graph`) the extractor synthesizes for an unmapped file — else
    // the de-blob drops the target and the beam vanishes. (When it lands on a real #root
    // module, that node was already kept below.)
    const attnTargets = new Set();
    snapshot.edges.forEach(e => { if (e.pred === 'attending') attnTargets.add(e.to); });
    // 1) structural nodes + program nodes (seed lastActive; traffic bumps it below).
    // attention CURSORS survive the agent de-blob too: they are the live light-show, not
    // collapsible firehose — keep the @attention:<uuid> node so its attending→module beam
    // lands somewhere visible (mirrors how a code module passes through, msg 7980).
    snapshot.nodes.forEach(n => {
      const t = typeOf(n);
      const fromAgents = (n.graph || 'agents') === 'agents';
      if (STRUCTURAL.has(t)) { ensure(n.id, t, n.attrs || {}); touch(n.id, nodeTime(n.attrs)); }
      else if (t === 'attention') { ensure(n.id, t, n.attrs || {}); touch(n.id, nodeTime(n.attrs)); }
      else if (attnTargets.has(n.id)) { ensure(n.id, isModule(n) ? 'module' : t, n.attrs || {}); touch(n.id, nodeTime(n.attrs)); }
      else if (!fromAgents && (isModule(n) || t === 'thread')) {
        ensure(n.id, isModule(n) ? 'module' : t, n.attrs || {}); touch(n.id, nodeTime(n.attrs));
      }
    });

    // 2) roll @run cost up onto the agent/party that ran it
    snapshot.nodes.forEach(n => {
      if (typeOf(n) !== 'run') return;
      const who = resolveParty((n.attrs || {}).agent, roleSlugs, agentHandles, roleHolder);
      if (!who) return;
      const node = ensure(who, nodeType(who), {});
      const c = Number((n.attrs || {}).cost_usd) || 0;
      const a = node.data.attrs;
      a.cost_usd = (Number(a.cost_usd) || 0) + c;
      a.runs = (Number(a.runs) || 0) + 1;
      touch(who, nodeTime(n.attrs));                    // a run is activity on its agent
    });

    // 3) aggregate who-talks-to-whom from every @msg
    const drillNode = {};                              // party id -> [msg]
    const drillEdge = {};                              // "src||dst" -> [msg]
    const talk = new Map();                            // key -> {src,dst,w}
    function pushDrill(map, k, m) { (map[k] = map[k] || []).push(m); }
    snapshot.nodes.forEach(n => {
      if (typeOf(n) !== 'msg') return;
      const a = n.attrs || {};
      const m = { id: n.id, from: a.from, to: a.to, subject: a.subject, body: a.body, sent_at: a.sent_at };
      const t = nodeTime(a);
      const s = resolveParty(a.from, roleSlugs, agentHandles, roleHolder);
      const d = resolveParty(a.to, roleSlugs, agentHandles, roleHolder);
      if (s) { ensure(s, nodeType(s), {}); nodes.get(s).data.weight++; touch(s, t); pushDrill(drillNode, s, m); }
      if (d && d !== s) { ensure(d, nodeType(d), {}); nodes.get(d).data.weight++; touch(d, t); pushDrill(drillNode, d, m); }
      if (s && d && s !== d) {
        const k = s + '||' + d;
        const t = talk.get(k) || { src: s, dst: d, w: 0 };
        t.w++; talk.set(k, t);
        pushDrill(drillEdge, k, m);
      }
    });

    // 4) edges: structural edges between kept nodes + aggregate talk edges
    const edges = [];
    snapshot.edges.forEach((e, i) => {
      if (nodes.has(e.from) && nodes.has(e.to))   // both endpoints survived → keep edge
        edges.push({ data: { id: 'se' + i, source: e.from, target: e.to, pred: e.pred,
                             kind: edgeKind(e.pred, e.kind), graph: e.graph } });
    });
    talk.forEach((t, k) =>
      edges.push({ data: { id: 'talk:' + k, source: t.src, target: t.dst, pred: '×' + t.w,
                           weight: t.w, kind: 'talk' } }));

    // re-label parties + stamp graph membership (synth parties default to agents).
    const graphOf = {}; snapshot.nodes.forEach(n => { graphOf[n.id] = n.graph || 'agents'; });
    nodes.forEach(node => {
      const d = node.data;
      d.label = labelFor(d.id, d.type, d.attrs, ctx[d.id]);
      d.graph = graphOf[d.id] || 'agents';
    });

    const typeSet = new Set([...nodes.values()].map(n => n.data.type));
    const types = [...typeSet].sort().map(t => ({ type: t, color: colorForType(t) }));
    return { nodes: [...nodes.values()], edges, types, drill: { byNode: drillNode, byEdge: drillEdge } };
  }

  // ---- CODE view: a beagle program materializing as an AST graph -------------
  // Agent typing keys on the id PREFIX (@agent: → agent). Code ids are uniform
  // (@<mod>#<n>), so code typing keys on the `kind` claim + a 1-hop head walk, per
  // fram-engine's CODE-RENDER-SCHEMA. This is the code analogue of nodeType/labelFor
  // above — same pure contract, different axis. Collapse is by AST depth, not party
  // aggregation (backbone is agent-specific, so code bypasses it entirely).
  const DEF_HEADS = new Set(['define', 'def', 'defn', 'defn-', 'defmacro', 'define-target',
    'define-mode', 'define-syntax', 'define-type', 'deftype', 'defrecord',
    'define-record-type', 'definterface', 'default-main']);
  const TYPE_HEADS = new Set(['define-type', 'deftype', 'defrecord', 'define-record-type', 'definterface']);
  const SLOT = /^(f\d+|seg\d+|comment\d+|tail)$/;        // ordered containment slots
  const LEAF_KIND = new Set(['text', 'string', 'number', 'keyword', 'char', 'bool']);
  const CODE_COLORS = { module: '#e8c34a', def: '#5bc16f', type: '#4aa3e8', expr: '#9b8cff',
    symbol: '#c0c8d0', literal: '#6fae8c', comment: '#7a8290' };

  function basename(p) { p = String(p); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

  // a code snapshot has @<mod>#<n|root> node ids OR `kind` attrs — agent ids never do.
  function isCodeSnapshot(snapshot) {
    return !!snapshot && Array.isArray(snapshot.nodes) && snapshot.nodes.some(
      n => /#(\d+|root)$/.test(n.id) || (n.attrs && n.attrs.kind != null));
  }

  // byId: id -> {attrs (literal preds), slots (SLOT preds -> target id)}.
  // slots come from the snapshot EDGES (f0 → @schema#2 is an @-id edge, not an attr).
  function buildById(snapshot) {
    const byId = new Map();
    snapshot.nodes.forEach(n => byId.set(n.id, { attrs: n.attrs || {}, slots: {} }));
    snapshot.edges.forEach(e => {
      if (!SLOT.test(e.pred)) return;
      let n = byId.get(e.from); if (!n) { n = { attrs: {}, slots: {} }; byId.set(e.from, n); }
      n.slots[e.pred] = e.to;
    });
    return byId;
  }

  // ONE code type from kind + a 1-hop head look (def/type need the head child's v).
  function codeType(id, byId) {
    const n = byId.get(id); if (!n) return 'node';
    const attrs = n.attrs || {};
    if (id.endsWith('#root') || attrs.file) return 'module';
    const kind = attrs.kind;
    if (kind === 'comment') return 'comment';
    if (kind === 'symbol') return 'symbol';
    if (LEAF_KIND.has(kind)) return 'literal';
    if (kind === 'list') {
      const head = byId.get(n.slots && n.slots.f0);
      const hv = head && head.attrs && head.attrs.v;
      if (hv === 'beagle-file') return 'module';
      if (TYPE_HEADS.has(hv)) return 'type';
      if (DEF_HEADS.has(hv)) return 'def';
      return 'expr';
    }
    return 'node';
  }

  // BFS depth from module roots over containment edges; parent = the edge it arrived by.
  function codeLevels(byId, roots) {
    const lvl = new Map(), parent = new Map();
    const q = roots.map(r => [r, 0, null]);
    for (let i = 0; i < q.length; i++) {
      const [id, d, par] = q[i];
      if (lvl.has(id)) continue;
      lvl.set(id, d); if (par != null) parent.set(id, par);
      const n = byId.get(id);
      if (n && n.slots) for (const p in n.slots) if (SLOT.test(p)) q.push([n.slots[p], d + 1, id]);
    }
    return { lvl, parent };
  }

  function codeLabel(id, type, byId) {
    const n = byId.get(id) || { attrs: {}, slots: {} };
    const a = n.attrs || {}, slots = n.slots || {};
    const nameOf = () => { const nm = byId.get(slots.f1); return (nm && nm.attrs && nm.attrs.v) || shortLabel(id); };
    switch (type) {
      case 'module':  return a.file ? basename(a.file) : shortLabel(id);
      case 'def':     return nameOf();
      case 'type':    return nameOf();
      case 'expr':    { const h = byId.get(slots.f0); return ((h && h.attrs && h.attrs.v) || '·') + '(…)'; }
      case 'symbol':  return a.v != null ? String(a.v) : shortLabel(id);
      case 'literal': return clip(a.v != null ? a.v : shortLabel(id), 24);
      case 'comment': return clip(a.v != null ? a.v : shortLabel(id), 24);
      default:        return shortLabel(id);
    }
  }

  // Build {nodes, edges, types, maxLevel} for a CODE snapshot, collapsed to level ≤ K.
  // Deeper subtrees fold into their nearest visible ancestor, badged with a hidden count.
  // K=0 → modules; K=1 → "the program is its defs"; K=∞ → full AST.
  function toCodeElements(snapshot, K) {
    if (K == null) K = 1;
    const byId = buildById(snapshot);
    const typeMap = new Map();
    byId.forEach((_, id) => typeMap.set(id, codeType(id, byId)));
    const roots = [...byId.keys()].filter(id => typeMap.get(id) === 'module');
    const { lvl, parent } = codeLevels(byId, roots);
    const levelOf = id => lvl.has(id) ? lvl.get(id) : 0;   // unreached → treat as visible top-level

    // representative = nearest ancestor with level ≤ K (self if already visible).
    const repCache = new Map();
    function rep(id) {
      if (repCache.has(id)) return repCache.get(id);
      let cur = id, guard = 0;
      while (levelOf(cur) > K && parent.has(cur) && guard++ < 100000) cur = parent.get(cur);
      repCache.set(id, cur); return cur;
    }

    const visible = new Map(), hidden = {};
    byId.forEach((_, id) => {
      const r = rep(id);
      if (r === id) {
        const t = typeMap.get(id);
        visible.set(id, { data: { id, type: t, label: codeLabel(id, t, byId),
          attrs: byId.get(id).attrs, level: levelOf(id), hidden: 0 } });
      } else hidden[r] = (hidden[r] || 0) + 1;
    });
    Object.keys(hidden).forEach(r => {
      const v = visible.get(r); if (!v) return;
      // fold badge + drive node size by folded mass, so a def hiding 500 atoms
      // reads bigger than one hiding 2 (codeSizeFor keys on `weight`).
      v.data.hidden = hidden[r]; v.data.weight = hidden[r]; v.data.label += '  +' + hidden[r];
    });

    // edges: containment slots only (hides redundant `child`), mapped to representatives.
    const seen = new Set(), edges = [];
    snapshot.edges.forEach(e => {
      if (!SLOT.test(e.pred)) return;
      const s = rep(e.from), t = rep(e.to);
      if (s === t || !visible.has(s) || !visible.has(t)) return;
      const key = s + '>' + t;
      if (seen.has(key)) return; seen.add(key);
      const m = e.pred.match(/\d+/);
      edges.push({ data: { id: 'ce:' + key, source: s, target: t, pred: m ? m[0] : e.pred, kind: 'child' } });
    });

    const typeSet = new Set([...visible.values()].map(n => n.data.type));
    const types = [...typeSet].sort().map(t => ({ type: t, color: CODE_COLORS[t] || colorForType(t) }));
    const maxLevel = lvl.size ? Math.max(...lvl.values()) : 0;
    return { nodes: [...visible.values()], edges, types, maxLevel };
  }

  global.GraphDomain = { nodeType, shortLabel, labelFor, colorForType, toCyElements, toBackbone,
    isCodeSnapshot, codeType, codeLevels, toCodeElements };
})(window);

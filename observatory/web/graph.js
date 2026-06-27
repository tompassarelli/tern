// graph.js — Cytoscape interop glue (DOM/render). The PURE transform lives in
// graph-domain.js; this file only wires it to Cytoscape + the live commit feed.
'use strict';

const Graph = (function () {
  let cy = null;
  let loadedPort = null;                 // sentinel: non-null once the union has loaded
  let graphVisible = { agents: true, code: true, board: true, work: true, attention: true };  // membership facet
  let typeColors = {};
  let mode = 'backbone';                 // 'backbone' (de-blobbed) | 'raw' (firehose)
  let drill = { byNode: {}, byEdge: {} };  // backbone drill-down: party/edge → messages
  let reloadT = null;
  let codeMode = false;                  // last snapshot was a code (AST) snapshot?
  let codeK = 1;                         // AST collapse depth (module=0, defs=1, …)
  let codeMaxLevel = 1;
  let interacting = false;               // user is dragging a node RIGHT NOW
  let layoutRun = null;                  // in-flight cy.layout() handle (so we can stop it)
  let dim = '2d';                        // '2d' (cytoscape) | '3d' (three.js sibling projection)
  let lastBuilt = null;                  // last toBackbone/toCyElements/toCodeElements output (so 3D renders without a refetch)

  // ---- view-engine state (9d7d): a view = filter × layout × color × edge-layers ----
  let layoutName = 'force';              // force | time | dag | radial
  let edgeLayers = { struct: true, talk: true, child: true, working: true, attending: true };  // toggleable edge layers by kind
  let sizeChannel = 'messages';          // size-by: messages | cost | context | recency (8972)
  let recencyMax = 45;                   // hide nodes idle > N min; >= MAX → show all (8972)
  const RECENCY_MAX = 120;               // slider ceiling == "show everything"
  let hideIsolates = true;               // de-blob: drop 0-degree nodes so the canvas reads
                                         // as connected structure, not a dot-grid. Toggle to show.

  // ---- light-show (item 4): the dark-room attention overlay ----
  // attention cursors (@attention:<uuid> attending→@module) glow as agent→code beams that
  // decay on retract/TTL. Dark-room dims everything but the live beams; lightFocus isolates
  // one agent's attention (click an agent) vs the whole-graph show (click empty).
  let lightShow = false;                 // dark-room on?
  let lightFocus = null;                 // uuid to isolate, or null = whole-graph show
  const ATTN_TTL_MS = 30000;             // client-side fade for an idle cursor (schema §5)
  // every node id that carries a uuid suffix (@attention:<uuid> / @agent:<uuid>) → that uuid,
  // so "click the agent, light its cursor" maps across the two node families.
  const uuidOf = id => { const c = String(id).indexOf(':'); return c > 0 ? id.slice(c + 1) : id; };
  // per-agent beam hue so multiple cursors on one module stay distinguishable (schema §6.1).
  function attnColor(srcId) {
    const h = GraphDomain.shortLabel(srcId);
    let x = 0; for (let i = 0; i < h.length; i++) x = (x * 31 + h.charCodeAt(i)) >>> 0;
    return `hsl(${x % 360}, 95%, 68%)`;
  }
  // a write-class touch is a strong focus; a read/grep is a soft glance (schema §6.2).
  const FOCUS_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const beamFocus = e => FOCUS_TOOLS.has(((e.source().data('attrs') || {}).attending_tool));
  const beamAgeMs = e => { const t = (e.source().data('attrs') || {}).attending_at;
                           const ms = t ? Date.parse(t) : 0; return ms ? Date.now() - ms : 0; };

  // code node size scales with folded mass — log curve so a 500-atom def and a
  // 2-atom def stay visually distinct instead of both pinning the sqrt cap.
  const codeSizeFor = w => 18 + Math.min(40, Math.log2(1 + Math.max(0, w || 0)) * 5);

  // raw magnitude of a node on the active size channel. Units differ wildly across
  // channels ($ vs counts vs minutes), so applySizes() min-max normalizes per render.
  function rawChannel(d) {
    const a = d.attrs || {};
    switch (sizeChannel) {
      case 'cost':    return Number(a.cost_usd) || 0;
      case 'context': return Number(a.context_tokens || a.context || a.tokens) || 0;
      case 'recency': { if (!d.lastActive) return 0; const age = (Date.now() - d.lastActive) / 60000; return Math.max(0, RECENCY_MAX - age); }
      case 'messages':
      default:        return Number(d.weight) || 0;
    }
  }
  // size every agents node off the active channel, normalized to the current max so the
  // spread is legible regardless of the channel's units. sqrt → perceptual area scaling.
  function applySizes() {
    if (!cy || codeMode) return;          // code keeps its own depth/mass curve in style()
    const ns = cy.nodes(); let max = 0; const raw = new Map();
    ns.forEach(n => { const v = rawChannel(n.data()); raw.set(n.id(), v); if (v > max) max = v; });
    cy.batch(() => ns.forEach(n => {
      const norm = max > 0 ? Math.sqrt(raw.get(n.id()) / max) : 0;
      n.data('_size', 20 + norm * 30);
    }));
  }

  // node SHAPE per type — a second, pre-attentive channel beside color (573b control
  // surface). Glyph maps to ROLE in the graph: actors=ellipse, roles=diamond, work/
  // threads=rounded box, messages=tag, runs=hexagon. Code types get their own AST shapes.
  const TYPE_SHAPES = {
    agent: 'ellipse', role: 'diamond', thread: 'round-rectangle', work: 'round-tag',
    team: 'star',
    msg: 'tag', run: 'hexagon', session: 'octagon', lease: 'vee', module: 'barrel',
    def: 'round-rectangle', type: 'diamond', expr: 'ellipse', symbol: 'ellipse',
    literal: 'round-rectangle', comment: 'cut-rectangle', node: 'ellipse',
  };
  // Tom override (71c1): PURE CIRCLES for every node for now — drop per-type shapes.
  // (TYPE_SHAPES kept as the dormant palette for when shape-as-channel returns.)
  const shapeFor = _t => 'ellipse';

  function style() {
    return [
      { selector: 'node', style: {
        'background-color': ele => typeColors[ele.data('type')] || '#6ea8ff',
        'shape': ele => shapeFor(ele.data('type')),
        'label': 'data(label)', 'color': '#cdd6ee', 'font-size': 10,
        'text-valign': 'bottom', 'text-margin-y': 3,
        'width': ele => codeMode ? codeSizeFor(ele.data('weight')) : (ele.data('_size') || 20),
        'height': ele => codeMode ? codeSizeFor(ele.data('weight')) : (ele.data('_size') || 20),
        'border-width': 0, 'text-outline-width': 2, 'text-outline-color': '#0c0f17',
        'min-zoomed-font-size': 7 } },
      { selector: 'node:selected', style: {
        'border-width': 3, 'border-color': '#ffffff' } },
      // structural edges (holds / supervisor / thread): thin, quiet.
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#2c3554', 'target-arrow-color': '#2c3554',
        'target-arrow-shape': 'triangle', 'arrow-scale': .7,
        'curve-style': 'bezier', 'opacity': .6,
        'label': 'data(pred)', 'font-size': 7, 'color': '#5b678a',
        'text-rotation': 'autorotate', 'min-zoomed-font-size': 8 } },
      // AST containment edges: directed parent→child tree, slot-index labels.
      { selector: 'edge[kind="child"]', style: {
        'width': 1.3, 'line-color': '#3a4466', 'target-arrow-color': '#3a4466', 'opacity': .75 } },
      // aggregate who-talks-to-whom edges: width = message volume, accent-tinted.
      { selector: 'edge[kind="talk"]', style: {
        'width': ele => 1.2 + Math.min(11, (ele.data('weight') || 1) * 0.7),
        'line-color': '#3a4a86', 'target-arrow-color': '#3a4a86', 'opacity': .8,
        'color': '#7f8fc4', 'font-size': 8 } },
      // CROSS-GRAPH working_on: the line connecting an agent to the code it touched.
      // Bright amber + dashed so it reads as a different, federated kind of edge.
      { selector: 'edge[kind="working"]', style: {
        'width': 2.4, 'line-color': '#f0a23a', 'target-arrow-color': '#f0a23a',
        'line-style': 'dashed', 'opacity': .9, 'curve-style': 'bezier',
        'label': 'working_on', 'color': '#f0a23a', 'font-size': 8 } },
      // LIGHT-SHOW (item 4): the attending beam — agent cursor → the module it's on NOW.
      // Color per agent, width/brightness by tool (write = bright solid, read = soft dashed),
      // arrow points at the code. The `.stale` class (client TTL) fades an idle beam.
      { selector: 'edge[kind="attending"]', style: {
        'width': ele => beamFocus(ele) ? 4 : 2,
        'line-color': ele => attnColor(ele.source().id()),
        'target-arrow-color': ele => attnColor(ele.source().id()),
        'target-arrow-shape': 'triangle', 'arrow-scale': 1,
        'line-style': ele => beamFocus(ele) ? 'solid' : 'dashed',
        'opacity': ele => beamFocus(ele) ? 0.95 : 0.6,
        'curve-style': 'bezier', 'z-index': 30,
        'line-cap': 'round', 'source-endpoint': 'outside-to-node', 'target-endpoint': 'outside-to-node',
        // (110a) DARK-ROOM LEGIBILITY: the beam label inherits the dim base-edge color and
        // is unreadable against black. Override it — tint to the beam's own agent color, sit
        // it on a dark pill, and wrap it in a dark outline so it glows off the beam at any
        // zoom. min-zoomed 0 = labels survive a zoomed-out room (where reading them matters).
        'label': 'data(pred)', 'text-rotation': 'autorotate',
        'color': ele => attnColor(ele.source().id()),
        'font-size': 9, 'font-weight': 'bold',
        'text-outline-width': 3, 'text-outline-color': '#04060c',
        'text-background-color': '#04060c', 'text-background-opacity': 0.7,
        'text-background-shape': 'roundrectangle', 'text-background-padding': 2,
        'min-zoomed-font-size': 0, 'z-index': 31 } },
      { selector: 'edge[kind="attending"].stale', style: { 'opacity': 0.12, 'line-style': 'dotted' } },
      // the cursor node itself + the module it lights — a hot ring so focus pops pre-attentively.
      { selector: 'node[type="attention"]', style: {
        'background-color': '#7ff0ee', 'border-width': 2, 'border-color': '#d6fffe',
        'text-outline-color': '#06222a', 'color': '#bdfffe', 'z-index': 25 } },
      { selector: 'node.attended', style: {
        'border-width': 5, 'border-color': '#7ff0ee', 'z-index': 20 } },
      { selector: 'node.attended-edit', style: { 'border-color': '#ffd166', 'border-width': 6 } },
      { selector: 'edge:selected', style: {
        'line-color': '#b388ff', 'target-arrow-color': '#b388ff', 'opacity': 1, 'width': 4 } },
      { selector: '.flash', style: {
        'background-color': '#ffffff', 'border-width': 6, 'border-color': '#b388ff' } },
      { selector: 'edge.flash', style: { 'line-color': '#b388ff', 'opacity': 1 } },
      { selector: '.dim', style: { 'opacity': .12 } },
      // light-show's own dimmer (kept distinct from search/legend `.dim` so they don't fight).
      { selector: '.ls-dim', style: { 'opacity': .06, 'text-opacity': 0 } },
      { selector: 'node.search-hit', style: {
        'border-width': 3, 'border-color': '#ffd166' } },
      // control surface: the locked-in source while drawing a typed edge, + the
      // user-asserted edge (distinct from the daemon's own struct edges).
      { selector: 'node.link-src', style: {
        'border-width': 4, 'border-color': '#4ade80', 'border-style': 'double' } },
      { selector: 'edge[kind="assert"]', style: {
        'width': 2.2, 'line-color': '#4ade80', 'target-arrow-color': '#4ade80',
        'opacity': .95, 'curve-style': 'bezier', 'color': '#7fe0a0', 'font-size': 8 } },
      // team membership: a soft halo binding a @team to its member agents (command layer).
      { selector: 'edge[pred="member"]', style: {
        'width': 1.8, 'line-color': '#b388ff', 'target-arrow-shape': 'none',
        'line-style': 'dotted', 'opacity': .7, 'label': '', 'curve-style': 'bezier' } },
      { selector: 'node[type="team"]', style: {
        'text-outline-color': '#1a1530', 'color': '#d8c8ff', 'font-size': 11 } },
    ];
  }

  function ensureCy() {
    if (cy) return cy;
    // additive selection so SHIFT/⌘-click accretes a multi-selection (→ group into a
    // @team). A plain tap is emulated back to single-select below.
    cy = cytoscape({ container: document.getElementById('cy'), style: style(),
      selectionType: 'additive', wheelSensitivity: .25, minZoom: .1, maxZoom: 3 });
    window.__cy = cy;   // QA/debug handle — lets headless screenshot drivers drive the graph

    // tap on a node: if a typed-edge gesture is armed, the FIRST tap locks the source
    // and the SECOND completes the link. SHIFT/⌘-tap accretes a multi-selection (no
    // panel). A plain tap is single-select + detail-pane (others cleared).
    // SELECTION IS DECOUPLED FROM THE LIGHT-SHOW: a plain click selects + opens detail
    // but never narrows the dark-room — "show ALL activity" stays the default. Isolating
    // one agent's beam is an explicit gesture: right-click (cxttap) an agent/cursor.
    cy.on('tap', 'node', evt => {
      if (link.action) return onLinkTap(evt.target);
      const oe = evt.originalEvent || {};
      if (oe.shiftKey || oe.metaKey || oe.ctrlKey) { syncSelection(); return; }
      cy.nodes().not(evt.target).unselect(); evt.target.select();
      showNode(evt.target); syncSelection();
    });
    // right-click an agent / its cursor → isolate THAT agent's beam (explicit, opt-in).
    // right-click anything else (or empty) → back to the whole-graph show.
    cy.on('cxttap', 'node', evt => {
      const t = evt.target.data('type');
      isolateAttention((t === 'agent' || t === 'attention') ? uuidOf(evt.target.id()) : null);
    });
    cy.on('tap', 'edge', evt => { if (evt.target.data('kind') === 'talk') showEdge(evt.target); });
    cy.on('tap', evt => { if (evt.target === cy) {
      if (link.action) cancelLink();
      else { cy.elements().unselect(); hideNode(); syncSelection(); isolateAttention(null); }  // empty click → whole-graph show
    }});
    cy.on('select unselect', 'node', syncSelection);
    // FREEZE auto-layout while the user is hands-on: a live commit must never
    // yank a node out from under an active drag. (Manual Re-layout overrides.)
    cy.on('grab', 'node', () => { interacting = true; });
    cy.on('free', 'node', () => { interacting = false; });
    return cy;
  }

  // the active layout config, keyed on layoutName (9d7d layout selector). force is the
  // fcose physics default; radial/dag use cytoscape built-ins; time is a custom preset.
  function layoutFor() {
    switch (layoutName) {
      case 'radial':
        return { name: 'concentric', animate: true, animationDuration: 600, fit: true, padding: 40,
          concentric: n => (Number(n.data('weight')) || 0) + n.degree(), levelWidth: () => 3,
          minNodeSpacing: 28 };
      case 'dag':
        return { name: 'breadthfirst', directed: true, animate: true, animationDuration: 600,
          fit: true, padding: 30, spacingFactor: 1.05 };
      case 'time':
        return timeLayout();
      case 'force':
      default:
        return { name: 'fcose', quality: 'default', animate: true, animationDuration: 700,
          randomize: false, nodeSeparation: 75, idealEdgeLength: 70, nodeRepulsion: 7000,
          packComponents: true };
    }
  }

  // time-hierarchical: a preset that maps lastActive → x (oldest left, freshest right)
  // and node TYPE → y lane, so the graph reads as a time tape with typed rows. Nodes
  // with no activity timestamp pin to the left margin.
  function timeLayout() {
    const ns = cy.nodes();
    let lo = Infinity, hi = -Infinity;
    ns.forEach(n => { const t = n.data('lastActive'); if (t) { if (t < lo) lo = t; if (t > hi) hi = t; } });
    const W = Math.max(800, ns.length * 26), H = 620;
    const span = hi > lo ? hi - lo : 1;
    const lane = {}, order = [];
    ns.forEach(n => { const ty = n.data('type') || 'node'; if (!(ty in lane)) { lane[ty] = order.length; order.push(ty); } });
    const rowH = H / Math.max(1, order.length);
    const pos = {};
    ns.forEach(n => {
      const t = n.data('lastActive');
      const x = t ? ((t - lo) / span) * W : -60;
      pos[n.id()] = { x, y: (lane[n.data('type') || 'node']) * rowH + rowH / 2 };
    });
    return { name: 'preset', positions: pos, animate: true, animationDuration: 600, fit: true, padding: 50 };
  }

  // run the full graph layout — the ONLY place that moves existing nodes. Skipped
  // mid-drag so it can't fight the user; manual Re-layout clears the freeze first.
  function runLayout() {
    if (interacting) return;
    cy.resize();   // re-read container dims before fit — guards stale 0×0 from a just-shown tab
    if (layoutRun) { try { layoutRun.stop(); } catch (e) {} }
    // lay out only VISIBLE elements — hidden isolates/stale nodes must not reserve space
    // or fcose's packComponents leaves holes where the dot-grid used to be.
    const eles = cy.elements(':visible');
    layoutRun = (eles.length ? eles : cy.elements()).layout(layoutFor());
    layoutRun.run();
  }
  function setLayout(name) {
    if (name === layoutName) return;
    layoutName = name; relayout();
  }

  // ---- node visibility = recency filter AND graph-membership facet ----------------
  // recencyMax >= RECENCY_MAX means "show everything". A node with no activity
  // timestamp (lastActive 0) is scaffold (a never-busy role/thread) — kept, not hidden.
  // graph-membership (agents/code/board/work) is a FILTER over the one union, not a port.
  function applyRecency() {  // kept name — callers across the file expect it
    if (!cy) return;
    const showAll = recencyMax >= RECENCY_MAX;
    const now = Date.now();
    cy.batch(() => cy.nodes().forEach(n => {
      const la = n.data('lastActive') || 0;
      const stale = !showAll && la > 0 && (now - la) / 60000 > recencyMax;
      const offGraph = graphVisible[n.data('graph') || 'agents'] === false;
      const isolate = hideIsolates && n.connectedEdges().length === 0;
      n.style('display', (stale || offGraph || isolate) ? 'none' : 'element');
    }));
  }
  function setRecencyMax(min) {
    min = parseInt(min, 10); if (isNaN(min)) return;
    recencyMax = Math.max(0, min); applyRecency(); applySizes();   // recency also feeds size-by:recency
  }
  function codeScoped() {
    return graphVisible.code !== false &&
           graphVisible.agents === false && graphVisible.board === false && graphVisible.attention === false;
  }
  // graph-membership facet: toggle a source daemon's nodes in/out of the union view. Toggling
  // code in/out can flip codeScoped (AST ⇄ union), so re-pull the snapshot, not just re-filter.
  function setGraphFilter(name, on) {
    graphVisible[name] = !!on;
    const wantCode = codeScoped();
    if (wantCode !== codeMode && loadedPort != null) { load(null, { relayout: false }); return; }
    applyRecency();
  }
  function getGraphVisible() { return Object.assign({}, graphVisible); }
  // de-blob facet: show/hide 0-degree nodes (the disconnected dot-grid). Re-arranges the
  // new visible set (fcose packComponents tidies revealed isolates off to the side, and
  // hiding lets the connected backbone spread to fill the canvas). 3D mirrors it.
  function setHideIsolates(on) {
    hideIsolates = !!on; applyRecency();
    if (dim === '3d') { render3d(); return; }
    runLayout();
  }
  function getHideIsolates() { return hideIsolates; }

  // ---- toggleable edge-layers (9d7d): show/hide edges by their `kind` --------------
  function applyEdgeLayers() {
    if (!cy) return;
    cy.batch(() => cy.edges().forEach(e => {
      const k = e.data('kind') || 'struct';
      e.style('display', edgeLayers[k] === false ? 'none' : 'element');
    }));
  }
  function setEdgeLayer(kind, on) { edgeLayers[kind] = !!on; applyEdgeLayers(); }
  function getEdgeLayers() { return Object.assign({}, edgeLayers); }
  function setSizeChannel(ch) { sizeChannel = ch; applySizes(); }

  // ---- light-show overlay (item 4): paint the attention layer over the graph ----------
  // Drives three things off the live `attending` beams: (1) light the module each cursor is
  // on (halo, write=amber/read=cyan), (2) client-side TTL — fade an idle beam past 30s until
  // the server retract lands, (3) dark-room — when on, everything but the live, in-focus beams
  // recedes into the dark. `lightFocus` isolates one agent; null = the whole-graph show.
  function applyLightShow() {
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().removeClass('attended attended-edit');
      cy.elements().removeClass('ls-dim');
      const beams = cy.edges('[kind="attending"]');
      const lit = cy.collection();          // the whole attention layer that survives dark-room
      beams.forEach(e => {
        e.toggleClass('stale', beamAgeMs(e) > ATTN_TTL_MS);
        const inFocus = !lightFocus || uuidOf(e.source().id()) === lightFocus;
        if (!inFocus) return;               // isolating another agent → recede with the field
        const tgt = e.target();
        // a FRESH beam lights its module (write=amber, glance=cyan); a stale one stays as a
        // faded TRAIL (its own .stale style) instead of vanishing — the show keeps its history.
        if (!e.hasClass('stale')) { tgt.addClass('attended'); if (beamFocus(e)) tgt.addClass('attended-edit'); }
        lit.merge(e).merge(e.source()).merge(tgt);
      });
      if (lightShow) {                        // dark-room: everything but the attention layer recedes
        cy.elements().addClass('ls-dim');
        lit.removeClass('ls-dim');
      } else if (lightFocus) {                // isolate w/o dark-room: just mute the other cursors
        beams.forEach(e => { if (uuidOf(e.source().id()) !== lightFocus) { e.addClass('ls-dim'); e.source().addClass('ls-dim'); } });
      }
    });
  }
  function setLightShow(on) {
    lightShow = !!on;
    const v = document.getElementById('graph-view');
    if (v) v.classList.toggle('light-show', lightShow);
    if (!lightShow) lightFocus = null;        // leaving the dark-room clears any isolate
    applyLightShow();
    if (dim === '3d') render3d();
  }
  function getLightShow() { return lightShow; }
  // isolate one agent's attention (click an agent/cursor) — or pass null for the whole show.
  function isolateAttention(uuid) { lightFocus = uuid || null; applyLightShow(); }

  // recency drifts with wall-clock even when no commit arrives — re-evaluate the
  // filter (and the recency size channel) on a slow tick so stale nodes fade out.
  setInterval(() => {
    if (!cy || loadedPort == null) return;
    applyRecency();
    if (sizeChannel === 'recency') applySizes();
  }, 20000);
  // light-show TTL ticks faster than the recency sweep — an idle beam should visibly fade
  // within a few seconds of crossing the 30s line, not wait for the slow filter pass. While
  // the dark-room is ON we also re-pull the federated snapshot (position-stable) so beams move
  // live even when the per-context live-WS isn't pointed at :7980 (full multi-daemon live-push
  // is item 6) — the dark-room is the one view where staleness defeats the whole point.
  setInterval(() => {
    if (!cy || loadedPort == null) return;
    if (lightShow) scheduleReload();
    if (lightShow || lightFocus || cy.edges('[kind="attending"]').length) applyLightShow();
  }, 4000);
  // manual Re-layout button: explicit user intent, so force it through the freeze.
  function relayout() {
    interacting = false;
    if (dim === '3d') { Graph3D.relayout(); return; }
    runLayout();
  }

  // INCREMENTAL diff: keep surviving nodes (and their positions) exactly where they
  // are, update changed data in place, add new, drop gone. Returns the ids of NEW
  // nodes so the caller can seat just those without a global re-layout. This is what
  // makes a live reload position-stable instead of a full teardown + animate.
  function reconcile(built) {
    const wantN = new Map(built.nodes.map(n => [n.data.id, n.data]));
    const wantE = new Map(built.edges.map(e => [e.data.id, e.data]));
    const added = [];
    cy.batch(() => {
      cy.nodes().forEach(n => { if (!wantN.has(n.id())) n.remove(); });
      cy.edges().forEach(e => { if (!wantE.has(e.id())) e.remove(); });
      const fresh = [];
      wantN.forEach((data, id) => {
        const ex = cy.getElementById(id);
        if (ex.length) ex.data(data); else { fresh.push({ group: 'nodes', data }); added.push(id); }
      });
      wantE.forEach((data, id) => {
        const ex = cy.getElementById(id);
        if (ex.length) ex.data(data); else fresh.push({ group: 'edges', data });
      });
      if (fresh.length) cy.add(fresh);
    });
    return added;
  }

  // model-coord center of the CURRENT viewport — seat new nodes where the user is
  // looking, not at some absolute origin off-screen.
  function viewCenter() { const e = cy.extent(); return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 }; }
  // seat newly-added nodes without disturbing the existing layout: each goes next to
  // an already-positioned neighbor (+ small spread), else near the viewport center.
  function placeNear(ids) {
    const fresh = new Set(ids);
    ids.forEach((id, i) => {
      const n = cy.getElementById(id);
      if (!n.length) return;
      let anchor = null;
      n.connectedEdges().connectedNodes().forEach(nb => {
        if (!anchor && nb.id() !== id && !fresh.has(nb.id())) anchor = nb.position();
      });
      const base = anchor || viewCenter();
      const a = i * 2.39996;                       // golden-angle spread, deterministic
      n.position({ x: base.x + Math.cos(a) * 46, y: base.y + Math.sin(a) * 46 });
    });
  }

  // opts.relayout: re-run the full layout (default true). A live auto-reload passes
  // false → reconcile data in place, preserving every existing position AND the
  // viewport; only freshly-arrived nodes get seated. relayout=true is for explicit
  // view changes (first paint, mode/depth switch, port change, manual Re-layout).
  // the graph is now the UNIFIED FEDERATED union of all live daemons — the bridge
  // unions :7978 (agents) + :7979 (code) + :7977 (board) into one node/edge set, so the
  // graph has no port: membership is a client-side filter facet. (`port` arg is vestigial
  // — ignored for the fetch; kept so the many existing call sites don't all change.)
  async function load(port, opts) {
    const relayout = !opts || opts.relayout !== false;
    ensureCy();
    const r = await fetch('/graph');
    const snap = await r.json();
    // The deep-AST transform (typed by `kind`, collapsed by depth) is a SCOPED view, only
    // when the filter is narrowed to code (Code preset). In the federated union — where
    // agents/attention/board are also in view — render the union via backbone/raw so code
    // passes through as module nodes and the attention beams + agents spine aren't hijacked
    // into a code-only AST render. (codeMode was snapshot-sniffed; gate it on the filter.)
    codeMode = GraphDomain.isCodeSnapshot(snap) && codeScoped();
    let built;
    if (codeMode) {
      built = GraphDomain.toCodeElements(snap, codeK);
      codeMaxLevel = built.maxLevel || 1;
    } else {
      built = mode === 'backbone' ? GraphDomain.toBackbone(snap) : GraphDomain.toCyElements(snap);
    }
    const { types } = built;
    drill = built.drill || { byNode: {}, byEdge: {} };
    typeColors = {}; types.forEach(t => typeColors[t.type] = t.color);

    const isFirst = cy.nodes().length === 0;     // nothing on canvas yet → must lay out
    const added = reconcile(built);
    cy.style(style());
    applySizes();                                // size-by channel (reads reconciled data)
    applyEdgeLayers();                           // edge-layer visibility
    applyRecency();                              // recency filter
    applyLightShow();                            // attention overlay (beams + dark-room + TTL)
    if (relayout || isFirst) runLayout();        // explicit / first paint → full layout + fit
    else if (added.length) placeNear(added);     // live reload → seat new nodes, viewport untouched
    renderLegend(types);
    syncCodeControls();
    lastBuilt = built;                            // cache for the 3D projection
    if (dim === '3d') render3d();                 // same data → sibling 3D canvas
    loadedPort = 1;                               // sentinel: the union is loaded
  }

  // ---- 3D projection (sibling of the 2D canvas) ----------------------------------
  // The view-engine lives HERE: 3D shares every facet (recency + membership filter,
  // edge-layers, color, size channel). We flatten lastBuilt to the SAME visible subset
  // the 2D canvas shows, then hand it to the dumb Graph3D renderer. graph3d.js only
  // adds what 3D is for: WebGL force layout, materialize-in, freeze-on-interaction.
  function build3dData() {
    if (!lastBuilt) return { nodes: [], links: [] };
    const showAll = recencyMax >= RECENCY_MAX, now = Date.now();
    const vis = new Set();
    // de-blob: nodes touched by ≥1 edge in the built set are "connected"; the rest are isolates.
    const connected = new Set();
    lastBuilt.edges.forEach(e => { connected.add(e.data.source); connected.add(e.data.target); });
    // size: mirror applySizes() — min-max normalize the active channel across visibles.
    const rawById = new Map(); let max = 0;
    lastBuilt.nodes.forEach(n => {
      const d = n.data, la = d.lastActive || 0;
      const stale = !showAll && la > 0 && (now - la) / 60000 > recencyMax;
      const off = graphVisible[d.graph || 'agents'] === false;
      const isolate = hideIsolates && !connected.has(d.id);
      if (stale || off || isolate) return;
      vis.add(d.id);
      const v = codeMode ? (codeSizeForRaw(d.weight)) : rawChannel(d);
      rawById.set(d.id, v); if (v > max) max = v;
    });
    const nodes = lastBuilt.nodes.filter(n => vis.has(n.data.id)).map(n => {
      const d = n.data, rv = rawById.get(d.id) || 0;
      const val = codeMode ? (10 + Math.min(40, rv)) : (8 + (max > 0 ? Math.sqrt(rv / max) : 0) * 26);
      return { id: d.id, label: d.label || d.id, type: d.type,
               color: typeColors[d.type] || '#6ea8ff', val };
    });
    const links = lastBuilt.edges.filter(e => {
      const d = e.data;
      return edgeLayers[d.kind || 'struct'] !== false && vis.has(d.source) && vis.has(d.target);
    }).map(e => {
      const d = e.data, kind = d.kind || 'struct';
      return { source: d.source, target: d.target, kind, pred: d.pred,
               color: Graph3D.EDGE_COLORS[kind] || '#2c3554',
               width: kind === 'talk' ? 0.5 + Math.min(5, (d.weight || 1) * 0.4) : (kind === 'working' ? 1.4 : kind === 'attending' ? 1.8 : 0.6) };
    });
    return { nodes, links };
  }
  // code nodes size off folded mass (no min-max channel) — log curve like codeSizeFor.
  function codeSizeForRaw(w) { return Math.log2(1 + Math.max(0, w || 0)) * 5; }

  function render3d() {
    if (!Graph3D.isMounted()) {
      Graph3D.mount(document.getElementById('cy3d'),
        { onNode: id => { const n = cy.getElementById(id); if (n.length) showNode(n); } });
    }
    Graph3D.render(build3dData());
  }

  // 2D ⇄ 3D toggle. Both consume the SAME built data; we just swap which canvas paints.
  function setDim(d) {
    if (d === dim) return;
    dim = d;
    const cyEl = document.getElementById('cy');
    if (d === '3d') {
      cyEl.style.visibility = 'hidden';
      document.getElementById('cy3d').style.display = 'block';  // visible+sized BEFORE mount
      render3d();                                 // mounts into the now-sized container
      Graph3D.resize();
    } else {
      Graph3D.hide();
      cyEl.style.visibility = '';
      cy && cy.resize();
    }
  }
  function getDim() { return dim; }

  // depth slider is only meaningful for code snapshots — show it when one is loaded.
  function syncCodeControls() {
    const c = document.getElementById('graph-depth');
    if (!c) return;
    c.classList.toggle('hidden', !codeMode);
    // depth lives in the ⚙ drawer now — pop it open when code loads so the slider is reachable.
    if (codeMode) {
      const d = document.getElementById('gc-drawer'), m = document.getElementById('gc-more');
      if (d && d.classList.contains('collapsed')) {
        d.classList.remove('collapsed');
        if (m) { m.classList.add('on'); m.setAttribute('aria-expanded', 'true'); }
      }
    }
    const sl = document.getElementById('depth-slider'), out = document.getElementById('depth-val');
    if (sl) { sl.max = String(Math.max(1, codeMaxLevel)); sl.value = String(codeK); }
    if (out) out.textContent = codeK >= codeMaxLevel ? 'full' : String(codeK);
  }
  function setDepth(k) {
    k = parseInt(k, 10); if (isNaN(k)) return;
    codeK = Math.max(0, k);
    if (loadedPort != null) load(loadedPort);
  }

  const graphActive = () => document.getElementById('graph-view').classList.contains('active');
  function ensure() { if (!loadedPort) load(); }
  function reset() { loadedPort = null; if (graphActive()) load(); }
  // toggle backbone (default, de-blobbed) ↔ raw (every atom). Reloads the canvas.
  function setMode(m) {
    if (m === mode) return;
    mode = m; loadedPort = null;
    if (graphActive()) load();
  }
  function getMode() { return mode; }

  function renderLegend(types) {
    const lg = document.getElementById('legend');
    lg.innerHTML = '<h4>node types</h4>';
    types.forEach(t => {
      const row = document.createElement('div'); row.className = 'row';
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = t.color;
      const lbl = document.createElement('span'); lbl.textContent = t.type;
      row.append(sw, lbl);
      row.onmouseenter = () => cy.elements().addClass('dim') && cy.nodes(`[type="${t.type}"]`).removeClass('dim').connectedEdges().removeClass('dim');
      row.onmouseleave = () => cy.elements().removeClass('dim');
      lg.append(row);
    });
  }

  function showNode(node) {
    const panel = document.getElementById('node-panel');
    const type = node.data('type');
    const id = node.id();
    const title = document.getElementById('node-title');
    title.innerHTML = '';
    title.append(el2('span', 'ntype', type), el2('span', 'nlabel', node.data('label') || id));
    const box = document.getElementById('node-claims');
    box.innerHTML = '';

    // UNIFY: clicking an agent node drives the live "watch it think" stream.
    if (type === 'agent' && window.Lodestar) {
      const act = el2('button', 'node-action', '▶ watch this agent think');
      act.onclick = () => window.Lodestar.openAgentStream(id.slice('@agent:'.length));
      box.append(act);
    }
    // a @team node: operate the group right from its detail pane.
    if (type === 'team') {
      const w = el2('button', 'node-action', '▶ work together');
      w.onclick = () => teamWorkTogether(id);
      const u = el2('button', 'node-action', '⬡ ungroup');
      u.onclick = () => ungroupTeam(id);
      box.append(w, u);
    }

    const attrs = node.data('attrs') || {};
    // `body` is the thread's prose — rendered as markdown below, not as a raw claim row.
    Object.keys(attrs).sort().filter(p => p !== 'body').forEach(p => box.append(claimRow(p, attrs[p], false)));
    // structural refs (this → that), skipping aggregate talk edges (shown as msgs below)
    node.connectedEdges().forEach(e => {
      if (e.data('kind') !== 'talk' && e.source().id() === id) box.append(claimRow(e.data('pred'), e.target().id(), true));
    });
    // incoming structural refs (that → this): e.g. a @role's holders.
    const incoming = node.connectedEdges().filter(e => e.data('kind') !== 'talk' && e.target().id() === id);
    if (incoming.length) {
      box.append(el2('div', 'claim-sec', `← referenced by ${incoming.length}`));
      incoming.forEach(e => box.append(claimRow('← ' + e.data('pred'), e.source().id(), true, e.source().data('label'))));
    }
    // thread prose → markdown (md.js owns sanitization). Board cards open here via selectNode.
    if (attrs.body && window.renderMarkdown) {
      box.append(el2('div', 'claim-sec', 'body'));
      const md = el2('div', 'md-body'); md.innerHTML = window.renderMarkdown(attrs.body);
      box.append(md);
    }
    // DRILL-DOWN: in backbone mode the messages live in the pane, not on the canvas.
    renderMessages(box, drill.byNode[id], `messages (${(drill.byNode[id] || []).length})`);
    panel.classList.remove('hidden');
    refitCanvas();
  }

  // an aggregate talk edge → the messages behind it (who-said-what, src → dst).
  function showEdge(edge) {
    const panel = document.getElementById('node-panel');
    const s = edge.source(), t = edge.target();
    const title = document.getElementById('node-title');
    title.innerHTML = '';
    title.append(el2('span', 'ntype', '×' + (edge.data('weight') || '')),
      el2('span', 'nlabel', `${s.data('label')} → ${t.data('label')}`));
    const box = document.getElementById('node-claims');
    box.innerHTML = '';
    const key = s.id() + '||' + t.id();
    renderMessages(box, drill.byEdge[key], `${(drill.byEdge[key] || []).length} messages`);
    panel.classList.remove('hidden');
    refitCanvas();
  }

  // shared message-list renderer (newest first); subject/body preview + sender.
  function renderMessages(box, msgs, heading) {
    if (!msgs || !msgs.length) return;
    box.append(el2('div', 'claim-sec', heading));
    msgs.slice().sort((a, b) => String(b.sent_at || b.id).localeCompare(String(a.sent_at || a.id)))
      .slice(0, 60)
      .forEach(m => {
        const row = el2('div', 'msg-row');
        row.append(el2('div', 'msg-head', `${m.from || '?'} → ${m.to || '?'}`));
        row.append(el2('div', 'msg-subj', m.subject || (m.body ? String(m.body).slice(0, 120) : m.id)));
        box.append(row);
      });
  }
  function el2(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function hideNode() { document.getElementById('node-panel').classList.add('hidden'); refitCanvas(); }
  document.getElementById('node-close').onclick = hideNode;

  // opening/closing the properties column resizes the canvas cell — let the grid settle,
  // then tell cytoscape (and the 3D sim) to re-read their box so nothing is clipped.
  function refitCanvas() {
    requestAnimationFrame(() => {
      if (cy) cy.resize();
      if (window.Graph3D && Graph3D.resize) Graph3D.resize();
    });
  }

  // ▤ Legend toggle — dock/hide the node-types key.
  (function wireLegendToggle() {
    const btn = document.getElementById('legend-toggle');
    if (!btn) return;
    btn.onclick = () => {
      const off = document.getElementById('graph-view').classList.toggle('legend-off');
      btn.classList.toggle('on', !off);
    };
  })();

  function claimRow(p, o, isRef, refLabel) {
    const c = document.createElement('div'); c.className = 'claim';
    const pe = document.createElement('div'); pe.className = 'p'; pe.textContent = p;
    const oe = document.createElement('div'); oe.className = 'o' + (isRef ? ' ref' : '');
    // a ref shows the target's HUMAN label, not its raw id (id on hover).
    oe.textContent = isRef ? (refLabel || (cy.getElementById(o).data('label')) || o) : o;
    if (isRef) { oe.title = o; oe.onclick = () => focus(o); }
    c.append(pe, oe);
    return c;
  }
  // center + select a node by id, opening its detail (cross-tab entry point).
  function focus(id) {
    if (!cy) return false;
    const n = cy.getElementById(id);
    if (!n.length) return false;
    cy.elements().unselect(); n.select(); cy.animate({ center: { eles: n }, duration: 250 });
    showNode(n);
    return true;
  }

  let toastT = null;
  function toast(msg) {
    const t = document.getElementById('graph-toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---- CONTROL SURFACE (573b): draw a typed edge → assert a claim ------------------
  // A gesture (select source → action key → click target) becomes a real claim in the
  // daemon via POST /edge, then optimistically appears as an `assert` edge. The action
  // map is the whole vocabulary: what the on-canvas drawing MEANS as a claim.
  //   assign  agent→work : the WORK gets `driver @agent` (+ the agent is msg'd the work)
  //   depends work→work  : (from `depends_on` to)
  //   relates  any→any   : (from `relates_to` to)
  //   watch   agent→thread: (agent `watching` thread)
  const LINK_ACTIONS = {
    assign:  { key: 'a', pred: 'driver',     subj: 'target', msg: true,
               hint: 'ASSIGN — click the work to hand it to this agent' },
    depends: { key: 'd', pred: 'depends_on', subj: 'source',
               hint: 'DEPENDS — click the work this one depends on' },
    relates: { key: 'r', pred: 'relates_to', subj: 'source',
               hint: 'RELATES — click the node it relates to' },
    watch:   { key: 'w', pred: 'watching',   subj: 'source',
               hint: 'WATCH — click the thread for this agent to watch' },
  };
  let link = { action: null, source: null };   // armed typed-edge gesture

  function clearLinkUI() {
    if (cy) cy.nodes().removeClass('link-src');
    document.body.classList.remove('linking');
    const b = document.getElementById('link-banner');
    if (b) b.classList.add('hidden');
  }
  function showLinkBanner(text) {
    let b = document.getElementById('link-banner');
    if (b) { b.textContent = text; b.classList.remove('hidden'); }
    document.body.classList.add('linking');
  }
  function cancelLink() { link = { action: null, source: null }; clearLinkUI(); toast('cancelled'); }

  // arm an action. If a node is already selected it becomes the source immediately,
  // so a one-handed "select → press a → click target" flow works.
  function startLink(action) {
    const a = LINK_ACTIONS[action]; if (!a || !cy) return;
    link = { action, source: null };
    const sel = cy.$('node:selected');
    if (sel.length) lockSource(sel[0]);
    else showLinkBanner(`${action}: click the SOURCE node`);
  }
  function lockSource(node) {
    const a = LINK_ACTIONS[link.action];
    link.source = node;
    cy.nodes().removeClass('link-src'); node.addClass('link-src');
    showLinkBanner(a.hint + '  ·  Esc to cancel');
  }
  function onLinkTap(node) {
    if (!link.source) { lockSource(node); return; }
    completeLink(node);
  }

  async function completeLink(target) {
    const a = LINK_ACTIONS[link.action], src = link.source;
    if (!src || target.id() === src.id()) { toast('pick a different target'); return; }
    // claim direction: `assign` writes the claim ON the work (subj=target), the rest
    // read source→target. obj is whichever endpoint isn't the subject.
    const subj = a.subj === 'target' ? target.id() : src.id();
    const obj  = a.subj === 'target' ? src.id()   : target.id();
    const verb = link.action;
    link = { action: null, source: null }; clearLinkUI();
    try {
      const r = await fetch('/edge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: subj, pred: a.pred, to: obj }) });
      const res = await r.json();
      if (!res.ok) { toast(`${verb} rejected`); return; }
      addAssertEdge(subj, a.pred, obj);
      // assign also pings the agent so the assignment is actionable, not just visual.
      if (a.msg) {
        const handle = src.id().startsWith('@agent:') ? src.id().slice('@agent:'.length) : src.id();
        const work = target.data('label') || target.id();
        fetch('/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: handle, body: `you are now driver of ${target.id()} — "${work}". (assigned from lodestar)` }) }).catch(() => {});
      }
      toast(`${verb}: ${shortId(subj)} ${a.pred} ${shortId(obj)}`);
    } catch (e) { toast('write failed — bridge needs restart?'); }
  }

  // optimistic edge with the SAME id scheme the live feed uses, so the daemon's own
  // commit (and any later reload) dedups onto it instead of doubling.
  function addAssertEdge(subj, pred, obj) {
    const eid = `live-${subj}->${obj}->${pred}`;
    if (cy.getElementById(eid).length === 0 && edgesByTriple(subj, pred, obj).length === 0)
      cy.add({ data: { id: eid, source: subj, target: obj, pred, kind: 'assert' } });
    flash(subj); flash(obj);
  }

  // create a work node on the canvas (n): bridge mints the @work:<id>, we seat it at the
  // viewport center and select it so the next keystroke can immediately link from it.
  async function createWork() {
    if (!cy) return;
    const title = prompt('New work node — title:');
    if (!title) return;
    try {
      const r = await fetch('/node', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'work', title }) });
      const res = await r.json();
      if (!res.ok || !res.id) { toast('create failed'); return; }
      const id = res.id;
      if (cy.getElementById(id).length === 0) {
        cy.add({ data: { id, label: title, type: 'work', attrs: { title }, weight: 0,
                         lastActive: Date.now(), graph: 'agents' } });
        const c = viewCenter(); cy.getElementById(id).position({ x: c.x, y: c.y });
      }
      if (!typeColors.work) { typeColors.work = GraphDomain.colorForType('work'); cy.style(style()); }
      cy.elements().unselect(); cy.getElementById(id).select();
      toast(`+ work ${shortId(id)} — press a to assign`);
    } catch (e) { toast('create failed — bridge needs restart?'); }
  }

  // ---- MULTI-SELECT → TEAM (command layer) -----------------------------------------
  // shift/⌘-click accretes a selection; grouping mints an @team:<id> whose members are
  // joined by `member` edges + an operational_requirements literal. "work together"
  // pings every member; ungroup dissolves it (retract + stand-down ping).
  function selectedNodes() {
    if (!cy) return [];
    return cy.$('node:selected').map(n => ({ id: n.id(), type: n.data('type'), label: n.data('label') || n.id() }));
  }
  // broadcast the live selection so the command layer can render its selection bar.
  function syncSelection() {
    document.dispatchEvent(new CustomEvent('fs:selection', { detail: selectedNodes() }));
  }
  function centroid(ids) {
    let x = 0, y = 0, c = 0;
    ids.forEach(id => { const n = cy.getElementById(id); if (n.length) { const p = n.position(); x += p.x; y += p.y; c++; } });
    return c ? { x: x / c, y: y / c } : viewCenter();
  }
  const handleOf = id => id.startsWith('@agent:') ? id.slice('@agent:'.length) : id;
  function ping(handle, body) {
    return fetch('/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: handle, body }) }).catch(() => {});
  }

  // group the selected AGENT nodes into a @team. reqs (optional) = the joint mandate.
  async function groupSelection(reqs) {
    if (!cy) return null;
    const members = selectedNodes().filter(n => n.type === 'agent');
    if (members.length < 2) { toast('shift-click 2+ agents to group'); return null; }
    const title = (reqs && reqs.slice(0, 40)) || members.map(m => m.label).join(' + ');
    try {
      const r = await fetch('/node', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'team', title }) });
      const res = await r.json();
      if (!res.ok || !res.id) { toast('team create failed'); return null; }
      const teamId = res.id, cen = centroid(members.map(m => m.id));
      if (!typeColors.team) typeColors.team = GraphDomain.colorForType('team');
      if (cy.getElementById(teamId).length === 0) {
        cy.add({ data: { id: teamId, label: '⬡ ' + title, type: 'team',
          attrs: { title, operational_requirements: reqs || '' }, weight: 0, lastActive: Date.now(), graph: 'agents' } });
        cy.getElementById(teamId).position(cen);
      }
      for (const m of members) {
        fetch('/edge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: teamId, pred: 'member', to: m.id }) }).catch(() => {});
        const eid = `live-${teamId}->${m.id}->member`;
        if (cy.getElementById(eid).length === 0)
          cy.add({ data: { id: eid, source: teamId, target: m.id, pred: 'member', kind: 'assert' } });
      }
      if (reqs) fetch('/edge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: teamId, pred: 'operational_requirements', to: reqs }) }).catch(() => {});
      cy.style(style());
      cy.elements().unselect(); cy.getElementById(teamId).select(); showNode(cy.getElementById(teamId));
      flash(teamId); syncSelection();
      toast(`⬡ team ${shortId(teamId)} — ${members.length} members`);
      return { teamId, members };
    } catch (e) { toast('team create failed — bridge?'); return null; }
  }
  function teamMembers(teamId) {
    const n = cy.getElementById(teamId); if (!n.length) return [];
    return n.connectedEdges().filter(e => e.data('pred') === 'member' && e.source().id() === teamId).map(e => e.target());
  }
  // "work together": ping every member with its teammates + the joint mandate.
  function teamWorkTogether(teamId) {
    const members = teamMembers(teamId);
    if (!members.length) { toast('no members'); return; }
    const reqs = (cy.getElementById(teamId).data('attrs') || {}).operational_requirements || '';
    const names = members.map(m => m.data('label') || m.id());
    members.forEach(m => {
      const me = m.data('label') || m.id();
      ping(handleOf(m.id()), `you're on team ${teamId} with ${names.filter(x => x !== me).join(', ')}. work together${reqs ? ': ' + reqs : ''}. (from lodestar)`);
    });
    flash(teamId); toast(`▶ pinged ${members.length} teammates`);
  }
  // dissolve: retract the member/title claims (durable; needs bridge /retract), stand
  // members down, and drop the team node from the canvas immediately.
  function ungroupTeam(teamId) {
    const n = cy.getElementById(teamId); if (!n.length) return;
    const members = teamMembers(teamId);
    const retract = (from, pred, to) => fetch('/retract', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, pred, to }) }).catch(() => {});
    members.forEach(m => { retract(teamId, 'member', m.id()); ping(handleOf(m.id()), `team ${teamId} dissolved — stand down the joint effort. (from lodestar)`); });
    const title = (n.data('attrs') || {}).title;
    if (title) retract(teamId, 'title', title);
    n.remove(); hideNode(); syncSelection();
    toast(`⬡ team ${shortId(teamId)} dissolved`);
  }

  // graph-scoped hotkeys: actions fire only on the Graph tab and never while typing in
  // a field (so the omni-search bar still accepts every letter).
  document.addEventListener('keydown', e => {
    if (!graphActive()) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (link.action) cancelLink(); return; }
    if (e.key === 'n') { e.preventDefault(); createWork(); return; }
    if (e.key === 'g') { e.preventDefault(); groupSelection(); return; }
    const act = Object.keys(LINK_ACTIONS).find(k => LINK_ACTIONS[k].key === e.key);
    if (act) { e.preventDefault(); startLink(act); }
  });

  // omni-search: full-text over the whole node, not just its id. matching nodes
  // stay bright + ring-highlighted; everything else dims. empty query clears it.
  function haystack(n) {
    const d = n.data();
    let s = n.id() + ' ' + (d.type || '') + ' ' + (d.label || '');
    const attrs = d.attrs || {};
    for (const k in attrs) s += ' ' + k + ' ' + attrs[k];
    n.connectedEdges().forEach(e => {
      if (e.source().id() === n.id()) s += ' ' + (e.data('pred') || '') + ' ' + e.target().id();
    });
    return s.toLowerCase();
  }
  function search(q) {
    if (!cy) return;
    q = (q || '').trim().toLowerCase();
    cy.batch(() => {
      if (!q) { cy.elements().removeClass('dim search-hit'); return; }
      cy.elements().addClass('dim');
      const hits = cy.nodes().filter(n => haystack(n).includes(q));
      hits.removeClass('dim').addClass('search-hit');
      cy.nodes().not(hits).removeClass('search-hit');
      hits.edgesWith(hits).removeClass('dim');
    });
  }

  // ---- presets (9d7d): a view = a saved {filter × layout × edge-layers × size} ------
  // The existing agents/code views are just BUILT-IN presets; user presets persist in
  // localStorage. Applying a preset is the one knob that drives the whole engine.
  // Built-in views = filter × layout × color × edge-layers, now including GRAPH-MEMBERSHIP
  // (which daemons are in view). "Everything" is the federated default; the rest are just
  // membership/layout filters over the same union — NOT separate per-port screens.
  const ALL_GRAPHS = { agents: true, code: true, board: true, work: true, attention: true };
  const BUILTIN_PRESETS = {
    Everything: { mode: 'backbone', layout: 'force', size: 'messages', graphVisible: ALL_GRAPHS },
    // the light-show as a saved view: dark-room on, cursors+code in focus, beams the only
    // bright layer. "A view = filter × layout × color × edge-layers" — dark-room is a facet.
    'Light Show': { mode: 'backbone', layout: 'force', size: 'recency', lightShow: true,
      graphVisible: { attention: true, code: true, agents: true, work: true },
      edgeLayers: { struct: false, talk: false, child: false, working: false, attending: true } },
    Agents:     { mode: 'backbone', layout: 'force', size: 'messages', graphVisible: { agents: true, work: true } },
    Code:       { mode: 'raw',      layout: 'dag',   size: 'messages', graphVisible: { code: true, work: true }, edgeLayers: { struct: false, talk: false, child: true, working: true } },
    Board:      { mode: 'backbone', layout: 'dag',   size: 'messages', graphVisible: { board: true } },
    'Agents+Code': { mode: 'backbone', layout: 'force', size: 'messages', graphVisible: { agents: true, code: true, work: true } },
    Raw:        { mode: 'raw',       layout: 'force', size: 'messages', graphVisible: ALL_GRAPHS },
    Timeline:   { mode: 'backbone',  layout: 'time',  size: 'recency',  edgeLayers: { struct: true, talk: true, child: false, working: true } },
  };
  const PRESET_KEY = 'lodestar.presets';
  function userPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch (e) { return {}; } }
  function writeUserPresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (e) {} }
  // current engine state as a preset object (what "Save preset" captures).
  function getState() {
    return { mode, layout: layoutName, size: sizeChannel, recencyMax, hideIsolates, lightShow,
             edgeLayers: Object.assign({}, edgeLayers),
             graphVisible: Object.assign({}, graphVisible) };
  }
  function listPresets() {
    const u = userPresets();
    return { builtin: Object.keys(BUILTIN_PRESETS), user: Object.keys(u) };
  }
  function applyPreset(name) {
    const p = BUILTIN_PRESETS[name] || userPresets()[name];
    if (!p) return false;
    if (p.layout) layoutName = p.layout;
    if (p.size) sizeChannel = p.size;
    if (p.recencyMax != null) recencyMax = p.recencyMax;
    if (p.hideIsolates != null) hideIsolates = p.hideIsolates;
    if (p.edgeLayers) edgeLayers = Object.assign({ struct: true, talk: true, child: true, working: true, attending: true }, p.edgeLayers);
    // a preset's graphVisible is the COMPLETE membership map (replace, not merge): default
    // every graph OFF, then turn on what the preset lists — so "Code"/"Agents"/"Light Show"
    // actually SCOPE the union instead of leaking the unlisted graphs back in.
    if (p.graphVisible) graphVisible = Object.assign({ agents: false, code: false, board: false, work: false, attention: false }, p.graphVisible);
    // dark-room is a view facet: a preset either lights the room or leaves it on. Toggle the
    // CSS class now; the load() below re-paints the overlay. (lightFocus resets on exit.)
    setLightShow(!!p.lightShow);
    // a mode change re-pulls + re-transforms the snapshot; otherwise just re-render in place.
    if (p.mode && p.mode !== mode) { mode = p.mode; loadedPort = null; }
    if (loadedPort != null) load(null, { relayout: true });
    else if (graphActive()) load();
    return true;
  }
  function savePreset(name) {
    name = (name || '').trim(); if (!name) return false;
    const u = userPresets(); u[name] = getState(); writeUserPresets(u); return true;
  }
  function deletePreset(name) {
    const u = userPresets(); if (!(name in u)) return false;
    delete u[name]; writeUserPresets(u); return true;
  }

  function typeOf(id) { return GraphDomain.nodeType(id); }
  const isStructuralType = t => t === 'agent' || t === 'role' || t === 'thread' || t === 'work';

  // backbone view shows AGGREGATES (msgs collapsed into talk-edges, costs rolled up),
  // so a single msg/session commit can't be patched in place — debounce a reload to
  // keep counts + deletions correct. Structural commits still patch live (below).
  function scheduleReload() {
    clearTimeout(reloadT);
    // relayout:false — patch aggregate counts/deletions in place; positions + viewport hold.
    reloadT = setTimeout(() => loadedPort != null && load(loadedPort, { relayout: false }), 700);
  }

  function onCommit(m) {
    if (!cy || loadedPort == null) return;
    // code materialization: a node's type depends on its head child (which may arrive
    // a frame later), so don't patch atoms in place — debounce a full reload that
    // re-runs the code transform over the whole accumulated snapshot.
    if (codeMode) { scheduleReload(); flash(m.l); toast(`${m.op} ${shortId(m.l)} ${m.p}`); return; }
    // LIGHT-SHOW: an attention commit (cursor move / tool change / TTL retract) re-pages the
    // whole transform — the beam targets a module that backbone's struct-edge patch won't
    // touch, and last-write-wins churn coalesces cleanly under the 700ms debounce. The
    // target module pulses on a fresh focus so the cursor's arrival reads as a flash of light.
    if (m.p === 'attending' || (m.l && m.l.indexOf('@attention:') === 0)) {
      scheduleReload();
      if (m.p === 'attending' && m.op === 'assert') flash(m.r);
      return;
    }
    if (m.ref) {
      if (m.op === 'assert') addEdge(m);
      else removeEdge(m);                       // RETRACT → live-remove the edge
    } else {
      if (m.op === 'assert') assertAttr(m);
      else retractAttr(m);                      // RETRACT → drop the attr (and prune cruft)
    }
    // in backbone mode, message/session traffic only moves aggregates — reload them.
    if (mode === 'backbone' && !isStructuralType(typeOf(m.l))) scheduleReload();
    else { applySizes(); applyEdgeLayers(); applyRecency(); }  // structural patch → re-apply view filters
    // 3D paints from lastBuilt, which an in-place cy patch doesn't touch — debounce a
    // reload so the sibling canvas stays live (materialize-in handles the new arrivals).
    if (dim === '3d') scheduleReload();
    flash(m.l);
    toast(`${m.op} ${shortId(m.l)} ${m.p}`);
  }

  // find a structural edge by its triple (source,target,pred) — NOT by a synthetic id,
  // so an edge that came from the initial snapshot (id "se7"/"e7") is found and removed
  // too. talk-edges (pred "×N") never match a real predicate, so msg retracts leave them.
  function edgesByTriple(l, p, r) {
    return cy.edges().filter(e => e.data('source') === l && e.data('target') === r && e.data('pred') === p);
  }
  function addEdge(m) {
    if (mode === 'backbone' && !(nodeExists(m.l) && (m.r.startsWith('@role:') || m.r.startsWith('@agent:'))))
      return;                                   // backbone only patches structural edges live
    const sn = ensureNode(m.l); ensureNode(m.r);
    if (edgesByTriple(m.l, m.p, m.r).length === 0)
      cy.add({ data: { id: `live-${m.l}->${m.r}->${m.p}`, source: m.l, target: m.r, pred: m.p, kind: 'struct' } });
    if (m.p === 'holds' && m.r.startsWith('@role:'))
      sn.data('label', GraphDomain.labelFor(m.l, sn.data('type'), sn.data('attrs') || {}, { role: m.r.slice(6) }));
  }
  function removeEdge(m) {
    edgesByTriple(m.l, m.p, m.r).remove();
    pruneIfCruft(m.l); pruneIfCruft(m.r);
  }
  function assertAttr(m) {
    if (mode === 'backbone' && !nodeExists(m.l)) return;  // don't materialize msg/session nodes
    const n = ensureNode(m.l);
    const attrs = Object.assign({}, n.data('attrs')); attrs[m.p] = m.r; n.data('attrs', attrs);
    n.data('label', GraphDomain.labelFor(m.l, n.data('type'), attrs, null));
  }
  function retractAttr(m) {
    const n = cy.getElementById(m.l);
    if (!n.length) return;
    const attrs = Object.assign({}, n.data('attrs')); delete attrs[m.p]; n.data('attrs', attrs);
    n.data('label', GraphDomain.labelFor(m.l, n.data('type'), attrs, null));
    pruneIfCruft(m.l);
  }
  // a node that has lost all its edges AND all its attrs is cruft — clear it live
  // (agents-commander's prune flow). Structural backbone nodes are kept regardless.
  function pruneIfCruft(id) {
    const n = cy.getElementById(id);
    if (!n.length || isStructuralType(n.data('type'))) return;
    const attrs = n.data('attrs') || {};
    if (n.connectedEdges().length === 0 && Object.keys(attrs).length === 0) n.remove();
  }
  function nodeExists(id) { return cy.getElementById(id).length > 0; }

  function ensureNode(id) {
    let n = cy.getElementById(id);
    if (n.length === 0) {
      const type = typeOf(id);
      if (!typeColors[type]) typeColors[type] = GraphDomain.colorForType(type);
      cy.add({ data: { id, label: GraphDomain.labelFor(id, type, {}, null), type, attrs: {}, weight: 0 } });
      n = cy.getElementById(id);
      placeNear([id]);                          // seat by a neighbor; NO global re-layout
    }
    return n;
  }
  function flash(id) {
    const n = cy.getElementById(id);
    if (n.length) { n.addClass('flash'); setTimeout(() => n.removeClass('flash'), 700); }
  }
  function shortId(id) { return GraphDomain.shortLabel(id); }

  return { ensure, reset, onCommit, search, focus, setMode, getMode, setDepth, relayout,
           setDim, getDim,
           setLayout, setEdgeLayer, getEdgeLayers, setSizeChannel, setRecencyMax,
           setGraphFilter, getGraphVisible, setHideIsolates, getHideIsolates,
           setLightShow, getLightShow, isolateAttention,
           listPresets, applyPreset, savePreset, deletePreset, getState,
           startLink, createWork, cancelLink, linkActions: () => Object.keys(LINK_ACTIONS),
           selectedNodes, groupSelection, ungroupTeam, teamWorkTogether, ping };
})();

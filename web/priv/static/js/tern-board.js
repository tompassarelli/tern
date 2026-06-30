// Claims-native KANBAN. Reads /api/list (the SAME source the list view uses) so
// the two surfaces can never disagree, and writes claims back via /api/tell +
// /api/retract — the round-trip the wake action primitive uses.
//
// MODEL: columns are the thread's intrinsic RESOLUTION only — Open (committed,
// not done), Draft (plan not yet committed), Done (work resolved). ATTENTION is
// NOT a column: active / scheduled / blocked render as card BADGES, exactly like
// the list's facetBadges. Lifecycle is derived from claims, never a stored status.
//
// DRAG: within a column reorders (priority claims 10,20,30…); across a column
// mutates the defining claim — Done sets outcome=done, Open sets committed=true,
// Draft RETRACTS committed. Auto-refreshes on the /live WebSocket.
// Everforest-dark-hard, matched to the rest of the surface.
(function () {
  const EF = {
    bg: "#272e33", panel: "#2e383c", edge: "#414b50", ink: "#d3c6aa",
    muted: "#859289", accent: "#7fbbb3", star: "#dbbc7f", ok: "#a7c080",
    warn: "#e67e80", purple: "#d699b6",
  };
  // resolution column -> hue (attention/scheduled/blocked are overlay badges).
  // Matches tern-list.js exactly so the dot/accent reads identically.
  const HUE = { open: EF.ok, draft: EF.purple, done: EF.muted };

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }

  async function tell(id, pred, obj) {
    try {
      await fetch("/api/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: "board", id, pred, obj }),
      });
    } catch (_) {}
  }

  // Retract a single claim — the inverse of tell. Draft is "uncommitted", so
  // moving a card back to Draft means dropping its `committed` claim entirely.
  async function retract(id, pred, obj) {
    try {
      await fetch("/api/retract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: "board", te: id, p: pred, r: obj }),
      });
    } catch (_) {}
  }

  // The human alias (a mutable claim, separate owner from identity). Subtle,
  // monospace, leads the title — matches tern-list.js's handleChip exactly.
  function handleChip(item) {
    if (!item.handle) return null;
    return el("span",
      `flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;` +
      `color:${EF.muted};border:1px solid ${EF.muted}55;border-radius:3px;padding:0 4px;white-space:nowrap;`,
      "@" + item.handle);
  }

  // one chip per ACTIVE axis — identical to the list's facetBadges so attention
  // reads the same on both surfaces. Attention (an agent on it now) leads.
  function facetBadges(item) {
    const wrap = el("span", "flex:0 0 auto;display:flex;gap:5px;align-items:center;");
    const chip = (txt, color, title) => {
      const c = el("span",
        `font-size:10px;color:${color};border:1px solid ${color}55;border-radius:3px;padding:0 5px;white-space:nowrap;`, txt);
      c.title = title; return c;
    };
    if (item.active) wrap.append(chip("▷ " + (item.driver ? item.driver.replace(/^@/, "") : "active"), EF.star, "active — an agent is attending now"));
    if (item.scheduled) wrap.append(chip("◷ " + (item.do_on || "soon"), EF.ok, "scheduled (do_on)"));
    if (item.blocked) wrap.append(chip("blocked", EF.warn, "blocked — open dependency"));
    if (item.completion && item.completion.total > 0) {
      const c = item.completion, full = c.done === c.total;
      wrap.append(chip("▦ " + c.done + "/" + c.total, full ? EF.ok : EF.muted, "emergent outcome — " + c.done + " of " + c.total + " sub-threads done"));
    }
    return wrap;
  }

  // Drag state is module-level so dragstart (delegated on the row) and dragend
  // can coordinate across columns. dragFrom = the lens the card started in.
  let dragEl = null, dragFrom = null;

  // y-position → the card to insert the dragged element before (null = append).
  // Same routine as tern-list.js's dragAfter.
  function dragAfter(container, y) {
    const cards = [...container.querySelectorAll("[data-id]")].filter((r) => r !== dragEl);
    let best = null, bestOff = -Infinity;
    for (const r of cards) {
      const box = r.getBoundingClientRect();
      const off = y - box.top - box.height / 2;
      if (off < 0 && off > bestOff) { bestOff = off; best = r; }
    }
    return best;
  }

  function card(it) {
    const accent = HUE[it.lens] || EF.muted;
    const k = el("div",
      `position:relative;display:flex;align-items:center;gap:9px;padding:9px 11px;margin:0 0 7px 0;` +
      `border:1px solid ${EF.edge};border-left:2px solid ${accent};border-radius:5px;` +
      `background:${EF.panel};font-size:13px;color:${EF.ink};cursor:grab;`);
    k.draggable = true;
    k.dataset.id = it.id;
    k.dataset.lens = it.lens;
    k.onmouseenter = () => { k.style.borderColor = accent; };
    k.onmouseleave = () => { k.style.borderColor = EF.edge; k.style.borderLeftColor = accent; };

    const dot = el("span", `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${accent};`);
    const handle = handleChip(it);
    const title = el("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", it.title);
    k.append(dot);
    if (handle) k.append(handle);
    k.append(title, facetBadges(it));
    return k;
  }

  // Done is the resting state → narrow by default; click its header to expand.
  // Persisted so the fold survives reload + live re-render.
  let doneExpanded = (() => {
    try { return localStorage.getItem("ls-board-done") === "1"; } catch (_) { return false; }
  })();
  const persistDone = () => { try { localStorage.setItem("ls-board-done", doneExpanded ? "1" : "0"); } catch (_) {} };

  function column(g, root) {
    const accent = HUE[g.key] || EF.muted;
    const narrow = g.key === "done" && !doneExpanded;
    const col = el("div",
      `flex:${narrow ? "0 0 190px" : "1 1 0"};min-width:${narrow ? "160px" : "240px"};` +
      `display:flex;flex-direction:column;background:${EF.bg};border:1px solid ${EF.edge};` +
      `border-radius:7px;overflow:hidden;`);
    col.dataset.col = g.key;

    const head = el("div",
      `flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px;` +
      `border-bottom:1px solid ${EF.edge};background:${EF.bg};` +
      `font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${EF.muted};` +
      (g.key === "done" ? "cursor:pointer;user-select:none;" : ""));
    const dot = el("span", `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${accent};`);
    const chip = el("span",
      `min-width:18px;text-align:center;font-size:10px;padding:0 5px;border-radius:8px;` +
      `background:${EF.panel};color:${accent};`, String(g.count));
    head.append(dot, el("span", "flex:1 1 auto;", g.label), chip);
    if (g.key === "done") {
      head.append(el("span", `flex:0 0 auto;font-size:12px;color:${EF.muted};`, doneExpanded ? "−" : "+"));
      head.onclick = () => { doneExpanded = !doneExpanded; persistDone(); render(root); };
    }
    col.append(head);

    const body = el("div", "flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:9px;");
    (g.items || []).forEach((it) => body.append(card(it)));
    if (!(g.items || []).length) {
      body.append(el("div", `padding:8px 4px;font-size:12px;color:${EF.edge};`, "—"));
    }
    col.append(body);

    // The whole column is a drop target: dragover relocates the dragged card
    // into this body (positioned by y), so dragend can read its resting column
    // to decide reorder (same column) vs resolution mutation (cross column).
    col.addEventListener("dragover", (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const after = dragAfter(body, e.clientY);
      if (after == null) body.appendChild(dragEl);
      else body.insertBefore(dragEl, after);
    });
    return col;
  }

  async function render(root) {
    let data;
    try { data = await fetch("/api/list").then((r) => r.json()); } catch (_) { return; }
    root.textContent = "";
    const groups = data.groups || [];

    // flex row; horizontal scroll only kicks in when flex-1 columns hit min-width.
    const row = el("div",
      `display:flex;gap:12px;align-items:stretch;height:100%;` +
      `overflow-x:auto;overflow-y:hidden;padding:14px;box-sizing:border-box;`);

    // Delegated drag lifecycle (mirrors tern-list.js: dragstart/dragover/dragend).
    row.addEventListener("dragstart", (e) => {
      dragEl = e.target.closest("[data-id]");
      if (dragEl) { dragFrom = dragEl.dataset.lens; dragEl.style.opacity = "0.4"; }
    });
    row.addEventListener("dragend", async () => {
      if (!dragEl) return;
      dragEl.style.opacity = "1";
      const moved = dragEl, from = dragFrom;
      dragEl = null; dragFrom = null;

      const targetCol = moved.closest("[data-col]");
      const to = targetCol && targetCol.dataset.col;
      if (!to) { render(root); return; }            // dropped nowhere → resync

      if (to === from) {
        // WITHIN a column: persist the new order as priority claims (10,20,30…).
        const ids = [...targetCol.querySelectorAll("[data-id]")].map((r) => r.dataset.id);
        await Promise.all(ids.map((id, i) => tell(id, "priority", String((i + 1) * 10))));
        render(root);
        return;
      }

      // CROSS column: set the destination column's defining resolution claim.
      const id = moved.dataset.id;
      if (to === "done") await tell(id, "outcome", "done");
      else if (to === "open") await tell(id, "committed", "true");
      else if (to === "draft") await retract(id, "committed", "true");
      render(root);
    });

    groups.forEach((g) => row.append(column(g, root)));
    root.append(row);
  }

  function liveRefresh(root) {
    let ws;
    // Coalesce a burst of /live frames into ONE refetch. A single commit can
    // emit several delta frames (one per claim); un-debounced, each would fire
    // a full /api/list refetch+render. The first frame arms a 50ms timer; every
    // frame arriving while it's pending is absorbed, so an N-claim commit
    // collapses to exactly one refetch+render (now ~35ms on the JSON wire).
    let timer = null;
    const scheduleRender = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; render(root); }, 50);
    };
    const open = () => {
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/api/live?graph=board`);
        ws.onmessage = (ev) => {
          // /live carries per-claim delta frames {t:"delta",graph,op,l,p,r}
          // (a multi-claim commit emits one each) plus the legacy commit/refresh
          // ping. A delta can't drive a per-card patch — it holds the changed
          // triple, not the thread's derived lifecycle/badges — so delta and
          // ping alike route to the same coalesced refetch.
          let frame = null;
          try { frame = JSON.parse(ev.data); } catch (_) {}
          // Ignore deltas for another graph; legacy pings still refresh.
          if (frame && frame.t === "delta" && frame.graph && frame.graph !== "board") return;
          scheduleRender();
        };
        ws.onclose = () => setTimeout(open, 2000);
      } catch (_) { setTimeout(open, 2000); }
    };
    open();
    setInterval(() => render(root), 15000); // backstop poll
  }

  window.tern = window.tern || {};
  window.tern.mountBoard = function ({ el: root }) {
    if (!root) return;
    // Thin themed scrollbars come from the shell's global CSS (* + ::-webkit-*);
    // nothing to inject here.
    root.style.cssText = `height:100%;background:${EF.bg};box-sizing:border-box;`;
    render(root);
    liveRefresh(root);
  };

  // Standalone boot when loaded on /board directly.
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("board");
    if (root) window.tern.mountBoard({ el: root });
  });
})();

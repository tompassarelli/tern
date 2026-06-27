// Claims-native list view. Reads /api/list (threads grouped by derived
// lifecycle), renders grouped lanes, and writes claims back via /api/tell —
// the same round-trip the wake action primitive uses. Auto-refreshes on the
// /live WebSocket (board commits) so it stays current with zero reload.
// Everforest-dark-hard, matched to the rest of the surface.
(function () {
  const EF = {
    bg: "#272e33", panel: "#2e383c", edge: "#414b50", ink: "#d3c6aa",
    muted: "#859289", accent: "#7fbbb3", star: "#dbbc7f", ok: "#a7c080",
    warn: "#e67e80", purple: "#d699b6",
  };
  // lens key -> accent (the dot + count chip). Lenses are the default grouping
  // of the orthogonal axes; per-row badges show the axes themselves.
  const HUE = {
    active: EF.star, blocked: EF.warn, scheduled: EF.ok,
    unscheduled: EF.accent, draft: EF.purple,
  };

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

  // Linear-style row actions — NO static buttons. Hover a row to target it, press
  // a hotkey; or right-click for the menu. Each action writes a claim (/api/tell).
  let hoverItem = null;
  const today = () => new Date().toISOString().slice(0, 10);
  const ACTIONS = [
    { key: "d", label: "Mark done", run: (it) => tell(it.id, "outcome", "done") },
    { key: "c", label: "Commit spec", run: (it) => tell(it.id, "committed", "true") },
    { key: "s", label: "Schedule today", run: (it) => tell(it.id, "do_on", today()) },
    { key: "u", label: "Unschedule", run: (it) => tell(it.id, "do_on", "") },
  ];

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(x, y, item) {
    closeMenu();
    menuEl = el("div",
      `position:fixed;left:${x}px;top:${y}px;z-index:1000;background:${EF.panel};border:1px solid ${EF.edge};` +
      `border-radius:6px;padding:4px;min-width:180px;box-shadow:0 6px 20px #0007;`);
    ACTIONS.forEach((a) => {
      const mi = el("div",
        `display:flex;justify-content:space-between;gap:18px;padding:6px 10px;border-radius:4px;font-size:12px;color:${EF.ink};cursor:pointer;`);
      mi.append(el("span", null, a.label), el("span", `color:${EF.muted};text-transform:uppercase;`, a.key));
      mi.onmouseenter = () => (mi.style.background = EF.bg);
      mi.onmouseleave = () => (mi.style.background = "transparent");
      mi.onclick = () => { a.run(item); closeMenu(); };
      menuEl.append(mi);
    });
    document.body.append(menuEl);
    const rb = menuEl.getBoundingClientRect();
    if (rb.right > innerWidth) menuEl.style.left = innerWidth - rb.width - 8 + "px";
    if (rb.bottom > innerHeight) menuEl.style.top = innerHeight - rb.height - 8 + "px";
  }

  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeMenu(); return; }
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return; // never hijack the CLI
    if (!hoverItem) return;
    const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
    if (a) { e.preventDefault(); a.run(hoverItem); }
  });

  // one chip per ACTIVE axis — makes the orthogonal axes explicit on every row.
  function facetBadges(item) {
    const wrap = el("span", "flex:0 0 auto;display:flex;gap:5px;align-items:center;");
    const chip = (txt, color, title) => {
      const c = el("span",
        `font-size:10px;color:${color};border:1px solid ${color}55;border-radius:3px;padding:0 5px;white-space:nowrap;`, txt);
      c.title = title; return c;
    };
    if (item.committed) wrap.append(chip("spec", EF.accent, "committed — plan resolved, ready to execute"));
    if (item.scheduled) wrap.append(chip(item.do_on || "scheduled", EF.ok, "scheduled (do_on)"));
    if (item.active && item.driver) wrap.append(chip(item.driver.replace(/^@/, ""), EF.star, "active — agent driving now"));
    if (item.blocked) wrap.append(chip("blocked", EF.warn, "blocked — open dependency"));
    return wrap;
  }

  function row(item) {
    const draggable = item.lens === "scheduled"; // only the next-up queue reorders
    const r = el("div",
      `display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid ${EF.edge};` +
      `cursor:${draggable ? "grab" : "default"};font-size:13px;color:${EF.ink};`);
    if (draggable) { r.draggable = true; r.dataset.id = item.id; }
    // Linear-style: hover targets the row for hotkeys; right-click opens actions.
    // No static per-row button — actions live in the context menu + keyboard.
    r.onmouseenter = () => { r.style.background = EF.panel; hoverItem = item; };
    r.onmouseleave = () => { r.style.background = "transparent"; if (hoverItem === item) hoverItem = null; };
    r.addEventListener("contextmenu", (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, item); });

    const dot = el("span", `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${HUE[item.lens] || EF.muted};`);
    const title = el("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", item.title);
    r.append(dot, title, facetBadges(item));
    return r;
  }

  let dragEl = null;

  // y-position → the row to insert the dragged element before (null = append).
  function dragAfter(container, y) {
    const rows = [...container.querySelectorAll("[data-id]")].filter((r) => r !== dragEl);
    let best = null, bestOff = -Infinity;
    for (const r of rows) {
      const box = r.getBoundingClientRect();
      const off = y - box.top - box.height / 2;
      if (off < 0 && off > bestOff) { bestOff = off; best = r; }
    }
    return best;
  }

  // collapsed group keys, persisted so folds survive reload + live re-render.
  const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem("ls-collapsed") || "[]"); } catch (_) { return []; } })());
  const saveCollapsed = () => { try { localStorage.setItem("ls-collapsed", JSON.stringify([...collapsed])); } catch (_) {} };

  function group(g, listEl) {
    const sec = el("div", "margin-bottom:2px;");
    const folded = collapsed.has(g.key);
    const head = el("div",
      `display:flex;align-items:center;gap:8px;padding:6px 14px;position:sticky;top:0;z-index:1;background:${EF.bg};` +
      `font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${EF.muted};` +
      `cursor:pointer;user-select:none;`);
    const caret = el("span", `width:9px;font-size:9px;color:${EF.muted};`, folded ? "▸" : "▾");
    const chip = el("span",
      `min-width:18px;text-align:center;font-size:10px;padding:0 5px;border-radius:8px;` +
      `background:${EF.panel};color:${HUE[g.key] || EF.muted};`, String(g.count));
    head.append(caret, el("span", null, g.label), chip);
    sec.append(head);

    const body = el("div");
    if (folded) body.style.display = "none";
    g.items.forEach((it) => body.append(row(it)));
    if (!g.items.length) body.append(el("div", `padding:6px 14px;font-size:12px;color:${EF.edge};`, "—"));
    sec.append(body);

    head.onclick = () => {
      const nowFolded = !collapsed.has(g.key);
      if (nowFolded) collapsed.add(g.key); else collapsed.delete(g.key);
      saveCollapsed();
      body.style.display = nowFolded ? "none" : "";
      caret.textContent = nowFolded ? "▸" : "▾";
    };

    // DRAG-RESEQUENCE (scheduled/next queue only): reorder rows, then persist the
    // new order as `priority` claims (10,20,30…) — claims-native, survives reload.
    if (g.key === "scheduled" && g.items.length > 1) {
      body.addEventListener("dragstart", (e) => {
        dragEl = e.target.closest("[data-id]");
        if (dragEl) dragEl.style.opacity = "0.4";
      });
      body.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!dragEl) return;
        const after = dragAfter(body, e.clientY);
        if (after == null) body.appendChild(dragEl);
        else body.insertBefore(dragEl, after);
      });
      body.addEventListener("dragend", async () => {
        if (!dragEl) return;
        dragEl.style.opacity = "1";
        dragEl = null;
        const ids = [...body.querySelectorAll("[data-id]")].map((r) => r.dataset.id);
        await Promise.all(ids.map((id, i) => tell(id, "priority", String((i + 1) * 10))));
        render(listEl);
      });
    }
    return sec;
  }

  async function render(root) {
    let data;
    try { data = await fetch("/api/list").then((r) => r.json()); } catch (_) { return; }
    root.textContent = "";
    const wrap = el("div", `max-width:760px;margin:0 auto;`);
    (data.groups || []).forEach((g) => wrap.append(group(g, root)));
    root.append(wrap);
  }

  function liveRefresh(root) {
    let ws;
    const open = () => {
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/api/live?graph=board`);
        ws.onmessage = () => render(root);
        ws.onclose = () => setTimeout(open, 2000);
      } catch (_) { setTimeout(open, 2000); }
    };
    open();
    setInterval(() => render(root), 15000); // backstop poll
  }

  // Claude-Code-shaped CLI: type a thought, Enter -> POST /api/capture -> the
  // claim lands in fram and the live feed surfaces it in Draft. The input IS a
  // claim-writer; no form ceremony.
  async function capture(title) {
    try {
      await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: "board", title }),
      });
    } catch (_) {}
  }

  function buildCli(listEl) {
    const bar = el("div",
      `flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid ${EF.edge};` +
      `background:${EF.bg};max-width:760px;margin:0 auto;width:100%;box-sizing:border-box;`);
    bar.append(el("span", `color:${EF.accent};font-size:14px;`, "›"));
    const input = el("input",
      `flex:1 1 auto;background:transparent;border:none;outline:none;color:${EF.ink};font-size:13px;` +
      `font-family:inherit;`);
    input.placeholder = "capture a thread…";
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        const v = input.value.trim();
        input.value = "";
        await capture(v);
        render(listEl);
      }
    });
    bar.append(input);
    return bar;
  }

  window.lodestar = window.lodestar || {};
  window.lodestar.mountList = function ({ el: root }) {
    if (!root) return;
    root.style.cssText = "height:100%;display:flex;flex-direction:column;";
    const listEl = el("div", "flex:1 1 auto;overflow:auto;");
    // CLI lives at the panel-frame level now (every panel gets a "›"); the list
    // is just the surface. capture()/buildCli kept for standalone use if needed.
    root.append(listEl);
    render(listEl);
    liveRefresh(listEl);
  };

  // Standalone boot when loaded on /list directly.
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("list");
    if (root) window.lodestar.mountList({ el: root });
  });
})();

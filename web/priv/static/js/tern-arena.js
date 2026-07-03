// EXP-025 ARENA — the filmable two-arm live task board (control vs graph).
//
// One experiment (?exp=<exp_id>), two columns side by side, ONE shared wall
// clock, task tiles that change colour as their `state` claim moves. Data comes
// from /api/arena?exp=…; the changing facets (state/cost/wall) are read fresh
// server-side each request, so a refetch is always current. Refreshes are PUSH:
// the /live WebSocket fires on every board commit (coalesced), with a 1.5s
// backstop poll — comfortably inside the demo's ≤2s liveness target.
//
// Stage legibility beats density: everything is oversized for a filmed 1080p
// screen. Everforest-dark-hard, matched to the rest of the tern surface.
(function () {
  const EF = {
    bg: "#272e33", panel: "#2e383c", edge: "#414b50", ink: "#d3c6aa",
    muted: "#859289", aqua: "#7fbbb3", amber: "#dbbc7f", green: "#a7c080",
    red: "#e67e80", blue: "#7fbbb3",
  };

  // state -> tile styling. `pulse` marks the running state for the CSS animation.
  const STATE = {
    pending:     { fg: EF.muted, bd: EF.edge,   bg: "#2b3237", label: "PENDING" },
    running:     { fg: EF.aqua,  bd: EF.aqua,   bg: "#2d3a3c", label: "RUNNING", pulse: true },
    "attempt-2": { fg: EF.amber, bd: EF.amber,  bg: "#38352c", label: "ATTEMPT 2" },
    "attempt-3": { fg: EF.amber, bd: EF.amber,  bg: "#3d382b", label: "ATTEMPT 3" },
    green:       { fg: EF.green, bd: EF.green,  bg: "#2f3a30", label: "GREEN" },
    blocked:     { fg: EF.red,   bd: EF.red,    bg: "#3a2e2f", label: "BLOCKED" },
    failed:      { fg: EF.red,   bd: EF.red,    bg: "#3a2b2c", label: "FAILED" },
  };
  // any state starting "attempt-" beyond 3 still reads amber.
  function styleFor(state) {
    if (STATE[state]) return STATE[state];
    if (typeof state === "string" && state.indexOf("attempt") === 0) {
      return { fg: EF.amber, bd: EF.amber, bg: "#3d382b", label: state.toUpperCase().replace("-", " ") };
    }
    return STATE.pending;
  }

  const ARM_LABEL = { control: "CONTROL · git", graph: "GRAPH · claim" };

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }

  function expId() {
    const p = new URLSearchParams(location.search);
    return p.get("exp") || "";
  }

  // Inject the pulse keyframes once (renderer owns its own CSS; no inline <script>).
  function ensureCss() {
    if (document.getElementById("arena-css")) return;
    const s = document.createElement("style");
    s.id = "arena-css";
    s.textContent =
      "@keyframes arenaPulse{0%,100%{opacity:1}50%{opacity:.45}}" +
      ".arena-run{animation:arenaPulse 1.05s ease-in-out infinite}";
    document.head.appendChild(s);
  }

  // ── shared wall clock ─────────────────────────────────────────────────────
  // Latch the EARLIEST start_ts ever observed so the clock is monotonic and
  // anchored to the true run start (server start_ts can drift as `updated`
  // moves). Tick locally so it advances smoothly between refetches.
  let anchorMs = null;
  let clockEl = null;

  function noteStart(iso) {
    if (!iso) return;
    const t = Date.parse(iso);
    if (isNaN(t)) return;
    if (anchorMs === null || t < anchorMs) anchorMs = t;
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
  }

  function tickClock() {
    if (!clockEl) return;
    if (anchorMs === null) { clockEl.textContent = "00:00"; return; }
    clockEl.textContent = fmtDur((Date.now() - anchorMs) / 1000);
  }

  // ── tiles + columns ───────────────────────────────────────────────────────
  function tile(t) {
    const st = styleFor(t.state);
    const k = el("div",
      `display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:10px;` +
      `border:2px solid ${st.bd};background:${st.bg};color:${EF.ink};` +
      `box-shadow:0 0 0 1px ${st.bd}22, 0 2px 10px #0003;`);
    if (st.pulse) k.className = "arena-run";

    const top = el("div", "display:flex;align-items:baseline;justify-content:space-between;gap:10px;");
    top.append(
      el("span", `font-size:1.9rem;font-weight:800;letter-spacing:.01em;color:${EF.ink};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;`, t.task_id),
      el("span", `font-size:1.05rem;font-weight:800;letter-spacing:.06em;color:${st.fg};white-space:nowrap;`, st.label)
    );

    const title = el("div",
      `font-size:1.05rem;color:${EF.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
      t.title || "");

    const foot = el("div",
      `display:flex;justify-content:space-between;font-size:1.25rem;font-weight:700;` +
      `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${EF.ink};margin-top:2px;`);
    foot.append(
      el("span", `color:${EF.amber};`, "$" + fmtMoney(t.cost_usd)),
      el("span", `color:${EF.muted};`, fmtDur(parseInt(t.wall_s, 10) || 0))
    );

    k.append(top, title, foot);
    return k;
  }

  function fmtMoney(v) {
    const n = parseFloat(v);
    return isNaN(n) ? "0.00" : n.toFixed(2);
  }

  function column(arm, col, accent) {
    const c = el("div",
      `flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:14px;` +
      `background:${EF.bg};border:1px solid ${EF.edge};border-top:4px solid ${accent};` +
      `border-radius:12px;padding:18px 18px 22px;overflow:hidden;`);

    const head = el("div", "display:flex;align-items:baseline;justify-content:space-between;gap:12px;");
    head.append(
      el("span", `font-size:2.1rem;font-weight:800;letter-spacing:.04em;color:${accent};`, ARM_LABEL[arm] || arm.toUpperCase())
    );

    const tot = (col && col.totals) || { green: 0, total: 0, cost_usd: 0, elapsed_s: 0 };
    const stats = el("div", "display:flex;gap:26px;align-items:baseline;");
    const stat = (val, lbl, color) => {
      const w = el("div", "display:flex;flex-direction:column;align-items:flex-end;line-height:1.05;");
      w.append(
        el("span", `font-size:1.9rem;font-weight:800;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${color};`, val),
        el("span", `font-size:.8rem;letter-spacing:.12em;color:${EF.muted};`, lbl)
      );
      return w;
    };
    stats.append(
      stat(tot.green + "/" + tot.total, "GREEN", EF.green),
      stat("$" + fmtMoney(tot.cost_usd), "COST", EF.amber),
      stat(fmtDur(tot.elapsed_s), "ARM", EF.muted)
    );
    head.append(stats);
    c.append(head);

    const grid = el("div",
      "display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;align-content:start;overflow-y:auto;");
    const tasks = (col && col.tasks) || [];
    if (!tasks.length) {
      grid.append(el("div", `color:${EF.edge};font-size:1.1rem;padding:12px;`, "— no tasks —"));
    } else {
      tasks.forEach((t) => grid.append(tile(t)));
    }
    c.append(grid);
    return c;
  }

  // ── render ────────────────────────────────────────────────────────────────
  async function render(root) {
    const exp = expId();
    let data;
    try {
      data = await fetch("/api/arena?exp=" + encodeURIComponent(exp)).then((r) => r.json());
    } catch (_) { return; }

    noteStart(data.start_ts);
    ensureCss();

    const cols = data.columns || {};

    root.textContent = "";
    const wrap = el("div",
      `height:100%;display:flex;flex-direction:column;gap:16px;padding:22px 26px 26px;` +
      `box-sizing:border-box;background:${EF.bg};`);

    // top bar: exp id (left) · big shared wall clock (centre) · legend (right)
    const bar = el("div", "display:flex;align-items:center;justify-content:space-between;gap:20px;");
    bar.append(
      el("div", `font-size:1.3rem;font-weight:700;color:${EF.muted};letter-spacing:.04em;`, exp || "(no exp)")
    );
    clockEl = el("div",
      `font-size:5.2rem;line-height:1;font-weight:800;letter-spacing:.02em;color:${EF.ink};` +
      `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;`);
    bar.append(clockEl);
    bar.append(legend());
    wrap.append(bar);

    const arena = el("div", "flex:1 1 auto;display:flex;gap:20px;min-height:0;");
    arena.append(
      column("control", cols.control, EF.blue),
      column("graph", cols.graph, EF.green)
    );
    wrap.append(arena);
    root.append(wrap);

    tickClock();
  }

  function legend() {
    const wrap = el("div", "display:flex;gap:14px;align-items:center;");
    const order = ["pending", "running", "attempt-2", "green", "blocked"];
    order.forEach((s) => {
      const st = styleFor(s);
      const chip = el("span", "display:flex;align-items:center;gap:6px;");
      chip.append(
        el("span", `width:14px;height:14px;border-radius:4px;border:2px solid ${st.bd};background:${st.bg};`),
        el("span", `font-size:.82rem;letter-spacing:.06em;color:${EF.muted};`, st.label)
      );
      wrap.append(chip);
    });
    return wrap;
  }

  // ── live refresh: /live WS (push) + backstop poll ─────────────────────────
  function live(root) {
    let timer = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; render(root); }, 60);
    };
    const open = () => {
      let ws;
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/api/live?graph=board`);
        ws.onmessage = (ev) => {
          let frame = null;
          try { frame = JSON.parse(ev.data); } catch (_) {}
          if (frame && frame.t === "delta" && frame.graph && frame.graph !== "board") return;
          schedule();
        };
        ws.onclose = () => setTimeout(open, 2000);
      } catch (_) { setTimeout(open, 2000); }
    };
    open();
    setInterval(() => render(root), 1500);  // backstop poll (≤2s liveness)
    setInterval(tickClock, 250);            // smooth local clock tick
  }

  function boot() {
    const root = document.getElementById("arena");
    if (!root) return;
    root.style.cssText = `height:100vh;background:${EF.bg};box-sizing:border-box;`;
    render(root);
    live(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

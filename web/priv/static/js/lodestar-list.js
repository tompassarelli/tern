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
  // group key -> accent (the status dot + count chip)
  const HUE = {
    "in-progress": EF.star, ready: EF.ok, blocked: EF.warn,
    backlog: EF.muted, draft: EF.purple,
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

  function row(item) {
    const r = el("div",
      `display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid ${EF.edge};` +
      `cursor:default;font-size:13px;color:${EF.ink};`);
    r.onmouseenter = () => (r.style.background = EF.panel);
    r.onmouseleave = () => (r.style.background = "transparent");

    const dot = el("span", `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${HUE[item.group] || EF.muted};`);
    const title = el("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", item.title);

    const meta = el("span", `flex:0 0 auto;font-size:11px;color:${EF.muted};`,
      item.group === "ready" && item.do_on ? item.do_on
        : item.group === "in-progress" && item.driver ? item.driver.replace(/^@/, "") : "");

    // claims-native action: mark done -> writes outcome=done -> /live -> refetch
    const done = el("button",
      `flex:0 0 auto;font-size:11px;padding:2px 8px;border:1px solid ${EF.edge};border-radius:4px;` +
      `background:transparent;color:${EF.muted};cursor:pointer;`, "done");
    done.onmouseenter = () => { done.style.color = EF.ok; done.style.borderColor = EF.ok; };
    done.onmouseleave = () => { done.style.color = EF.muted; done.style.borderColor = EF.edge; };
    done.onclick = (e) => { e.stopPropagation(); tell(item.id, "outcome", "done"); };

    r.append(dot, title, meta, done);
    return r;
  }

  function group(g) {
    const sec = el("div", "margin-bottom:2px;");
    const head = el("div",
      `display:flex;align-items:center;gap:8px;padding:6px 14px;position:sticky;top:0;background:${EF.bg};` +
      `font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${EF.muted};`);
    const chip = el("span",
      `min-width:18px;text-align:center;font-size:10px;padding:0 5px;border-radius:8px;` +
      `background:${EF.panel};color:${HUE[g.key] || EF.muted};`, String(g.count));
    head.append(el("span", null, g.label), chip);
    sec.append(head);
    g.items.forEach((it) => sec.append(row(it)));
    if (!g.items.length) sec.append(el("div", `padding:6px 14px;font-size:12px;color:${EF.edge};`, "—"));
    return sec;
  }

  async function render(root) {
    let data;
    try { data = await fetch("/api/list").then((r) => r.json()); } catch (_) { return; }
    root.textContent = "";
    const wrap = el("div", `max-width:760px;margin:0 auto;`);
    (data.groups || []).forEach((g) => wrap.append(group(g)));
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

  window.lodestar = window.lodestar || {};
  window.lodestar.mountList = function ({ el: root }) {
    if (!root) return;
    root.style.height = "100vh";
    root.style.overflow = "auto";
    render(root);
    liveRefresh(root);
  };

  // Standalone boot when loaded on /list directly.
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("list");
    if (root) window.lodestar.mountList({ el: root });
  });
})();

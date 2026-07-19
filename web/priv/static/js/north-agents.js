// Provider-neutral AGENTS panel. Reads /api/agents (the live semantic roster) and
// /api/agents/<handle>/stream (one agent's chat), rendering a two-region view:
// a roster up top, the selected agent's conversation below. Writes go back via
// /api/tell — the same fact round-trip the rest of the surface uses. Roster
// auto-refreshes on the /live WebSocket; the open stream re-polls on a short
// interval. Everforest-dark-hard, matched to the rest of the surface.
(function () {
  const EF = {
    bg: "#272e33", panel: "#2e383c", edge: "#414b50", ink: "#d3c6aa",
    muted: "#859289", accent: "#7fbbb3", star: "#dbbc7f", ok: "#a7c080",
    warn: "#e67e80", purple: "#d699b6",
  };

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }

  // Preserve the provider's exact integer count; separators add legibility
  // without turning usage into an estimate.
  function fmtTokens(n) {
    if (n == null || n === "") return null;
    n = Number(n);
    return Number.isSafeInteger(n) && n >= 0 ? n.toLocaleString("en-US") : null;
  }

  function fmtUsage(n, status) {
    const exact = fmtTokens(n);
    if (exact == null) return "unknown";
    if (status === "exact" || status == null) return exact;
    if (status === "incomplete") return `≥${exact} (incomplete)`;
    return "unknown";
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

  // --- module state: the roster, the current selection, and where the chat
  // renders. render() rebuilds the roster but must preserve `selected`; the
  // stream poll reads `selected` + `agents` independently.
  let agents = [];
  let selected = null; // the selected agent's uuid (used as the stream handle)
  let chatEl = null;

  function handleOf(a) { return a.uuid; }
  function find(handle) { return agents.find((a) => handleOf(a) === handle) || null; }
  function semanticName(a) {
    return a.display_name || a.display_handle || "unnamed agent";
  }
  function semanticAxes(a) {
    return [
      a.provider_label || a.provider || "provider:unobserved",
      a.model_display || a.model || "model:unobserved",
      a.effort || "effort:unobserved",
      a.gaffer_provenance || "gaffer:legacy-debt",
    ].join(" · ");
  }

  function rosterRow(a) {
    const handle = handleOf(a);
    const isSel = handle === selected;
    const r = el("div",
      `display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid ${EF.edge};` +
      `cursor:pointer;font-size:13px;color:${EF.ink};background:${isSel ? EF.panel : "transparent"};`);
    r.dataset.handle = handle;
    r.onmouseenter = () => { if (handle !== selected) r.style.background = EF.panel; };
    r.onmouseleave = () => { if (handle !== selected) r.style.background = "transparent"; };
    r.onclick = () => selectAgent(handle);

    const dot = el("span",
      `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${a.online ? EF.ok : EF.edge};`);

    const identity = el("span",
      `flex:0 1 330px;min-width:180px;display:flex;flex-direction:column;gap:2px;overflow:hidden;`);
    identity.append(
      el("span",
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${isSel ? 600 : 400};`,
        semanticName(a)),
      el("span",
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:${EF.accent};`,
        semanticAxes(a)),
      el("span",
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:${EF.muted};`,
        `${a.state_label || a.state || "state:unrecorded"} · lifecycle:${a.lifecycle || "unrecorded"}`),
    );

    // context (active) / total (all-time) token figure
    const toks = el("span", `flex:0 0 auto;font-size:11px;color:${EF.star};`,
      `${fmtUsage(a.context_tokens, a.context_status)}/${fmtUsage(a.total_tokens, a.total_status)}`);

    const elapsed = el("span", `flex:0 0 auto;font-size:11px;color:${EF.muted};`, a.elapsed_str || "");

    const snippet = el("span",
      `flex:1 1 auto;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `font-size:11px;color:${EF.muted};`,
      a.task || a.goal || a.active_workflow || a.current_thread || a.state_label || "");

    r.title = [
      semanticName(a),
      semanticAxes(a),
      `model ${a.model || "unrecorded"}`,
      `state ${a.state_label || a.state || "unrecorded"}`,
      `lifecycle ${a.lifecycle || "unrecorded"}`,
      `task ${a.task || a.goal || "unrecorded"}`,
      `control ${a.control_id || handle}`,
    ].join("\n");
    r.append(dot, identity, toks, elapsed, snippet);
    return r;
  }

  // Per-kind chat styling. "user" = human turn (accent, distinct); "text" =
  // assistant prose; "tool" = a tool invocation (name only); "result" = a final
  // result payload. Unknown kinds fall back to the assistant look.
  function kindStyle(kind) {
    switch (kind) {
      case "user":   return { label: "user",      color: EF.accent, text: EF.ink,   border: EF.accent, mono: false };
      case "tool":   return { label: "tool",      color: EF.star,   text: EF.star,  border: EF.star,   mono: true  };
      case "result": return { label: "result",    color: EF.ok,     text: EF.muted, border: EF.ok,     mono: false };
      default:       return { label: "assistant", color: EF.purple, text: EF.ink,   border: EF.edge,   mono: false };
    }
  }

  function chatLine(m) {
    const s = kindStyle(m.kind);
    const line = el("div",
      `padding:6px 14px;border-left:2px solid ${s.border};margin:4px 0;`);
    line.append(el("div",
      `font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${s.color};margin-bottom:2px;`,
      s.label));
    line.append(el("div",
      `font-size:13px;color:${s.text};white-space:pre-wrap;word-break:break-word;` +
      (s.mono ? `font-family:ui-monospace,monospace;` : ``), m.text || ""));
    return line;
  }

  function renderChat() {
    if (!chatEl) return;
    chatEl.textContent = "";
    const wrap = el("div", `max-width:760px;margin:0 auto;`);
    const a = find(selected);

    if (!selected || !a) {
      wrap.append(el("div", `padding:14px;font-size:12px;color:${EF.edge};`, "select an agent"));
      chatEl.append(wrap);
      return;
    }

    const head = el("div",
      `display:flex;align-items:center;gap:8px;padding:8px 14px;position:sticky;top:0;background:${EF.bg};` +
      `font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${EF.muted};`);
    head.append(el("span", `width:7px;height:7px;border-radius:50%;background:${a.online ? EF.ok : EF.edge};`));
    const identity = el("span", "display:flex;flex-direction:column;gap:1px;min-width:0;");
    identity.append(
      el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", semanticName(a)),
      el("span", `color:${EF.accent};font-size:10px;font-weight:400;text-transform:none;`,
        semanticAxes(a)),
      el("span", `color:${EF.muted};font-size:9px;font-weight:400;text-transform:none;`,
        `${a.state_label || a.state || "state:unrecorded"} · lifecycle:${a.lifecycle || "unrecorded"}`),
      el("span", `color:${EF.muted};font-size:9px;font-weight:400;text-transform:none;`,
        `control ${a.control_id || selected}`),
    );
    head.append(identity);
    if (a.roles_str) head.append(el("span", `color:${EF.accent};font-weight:400;text-transform:none;`, a.roles_str));
    wrap.append(head);

    const msgs = (chatEl._stream && chatEl._stream.handle === selected) ? (chatEl._stream.messages || []) : [];
    if (!msgs.length) wrap.append(el("div", `padding:6px 14px;font-size:12px;color:${EF.edge};`, "—"));
    msgs.forEach((m) => wrap.append(chatLine(m)));

    // live deliberation indicator — uses the roster entry's clocks, not the stream
    if (a.thinking) {
      wrap.append(el("div",
        `padding:8px 14px;font-size:12px;font-style:italic;color:${EF.star};`,
        `Deliberating… (${a.elapsed_str || "0s"} · ↑${fmtUsage(a.context_tokens, a.context_status)})`));
    }

    chatEl.append(wrap);
  }

  async function loadStream() {
    if (!selected || !chatEl) return;
    const handle = selected;
    try {
      const data = await fetch(`/api/agents/${encodeURIComponent(handle)}/stream`).then((r) => r.json());
      if (selected !== handle) return; // selection moved while in flight
      chatEl._stream = data;
    } catch (_) { return; }
    renderChat();
  }

  function selectAgent(handle) {
    if (selected === handle) return;
    selected = handle;
    window.north.agentSelection = handle; // the frame "›" steers this agent
    if (chatEl) chatEl._stream = null;
    rebuildRoster();
    renderChat();
    loadStream();
  }

  // rebuild only the roster region from `agents`, preserving selection highlight.
  let rosterEl = null;
  function rebuildRoster() {
    if (!rosterEl) return;
    rosterEl.textContent = "";
    const wrap = el("div", `max-width:760px;margin:0 auto;`);
    const head = el("div",
      `display:flex;align-items:center;gap:8px;padding:6px 14px;position:sticky;top:0;background:${EF.bg};` +
      `font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${EF.muted};`);
    head.append(el("span", null, "agents"));
    head.append(el("span",
      `min-width:18px;text-align:center;font-size:10px;padding:0 5px;border-radius:8px;background:${EF.panel};color:${EF.ok};`,
      String(agents.filter((a) => a.online).length)));
    wrap.append(head);

    if (!agents.length) wrap.append(el("div", `padding:6px 14px;font-size:12px;color:${EF.edge};`, "—"));
    agents.forEach((a) => wrap.append(rosterRow(a)));
    rosterEl.append(wrap);
  }

  async function render(root) {
    rosterEl = root;
    let data;
    try { data = await fetch("/api/agents").then((r) => r.json()); } catch (_) { return; }
    agents = data.agents || [];

    // default-select the first online agent; keep selection if it still exists.
    if (!selected || !find(selected)) {
      const first = agents.find((a) => a.online) || agents[0];
      if (first) {
        selected = handleOf(first);
        window.north.agentSelection = selected; // the frame "›" steers this agent
        if (chatEl) chatEl._stream = null;
        loadStream();
      }
    }

    rebuildRoster();
    renderChat();
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
    setInterval(() => loadStream(), 4000);  // re-poll the open agent's stream
  }

  window.north = window.north || {};
  window.north.mountAgents = function ({ el: root }) {
    if (!root) return;
    // Conversation-first shape, top→bottom: the selected agent's chat
    // (dominant) → steer input → agent picker beneath it.
    root.style.cssText = "height:100%;display:flex;flex-direction:column;";
    chatEl = el("div", "flex:1 1 auto;min-height:0;overflow:auto;");

    const cli = el("div",
      `flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid ${EF.edge};`);
    cli.append(el("span", `color:${EF.accent};font-size:14px;`, "›"));
    const input = el("input",
      `flex:1 1 auto;background:transparent;border:none;outline:none;color:${EF.ink};font-size:13px;font-family:inherit;`);
    input.placeholder = "message the selected agent…";
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && input.value.trim() && selected) {
        const v = input.value.trim(); input.value = "";
        try {
          await fetch("/api/steer", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ handle: selected, text: v }),
          });
        } catch (_) {}
      }
    });
    cli.append(input);

    rosterEl = el("div", `flex:0 0 auto;max-height:30vh;overflow:auto;border-top:1px solid ${EF.edge};`);

    root.append(chatEl, cli, rosterEl);
    render(rosterEl);
    liveRefresh(rosterEl);
  };

  // Standalone boot when loaded on /agents directly.
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("agents");
    if (root) window.north.mountAgents({ el: root });
  });
})();

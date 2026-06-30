// Escape-hatch mounts for the wake frontend. wake carves a container and calls
// window.tern.mountGraph({el, wake}); we render the Cytoscape thread DAG
// into it (data from /api/dag). Everforest palette. Uses the global `cytoscape`.

(function () {
  const EF = {
    bg: "#272e33", edge: "#414b50", ink: "#d3c6aa", muted: "#859289",
    accent: "#7fbbb3", star: "#dbbc7f", ok: "#a7c080", warn: "#e67e80", purple: "#d699b6",
  };
  const STATUS = { active: EF.star, blocked: EF.warn, ready: EF.accent, backlog: EF.muted };

  // focus = the @id of the thread the view is centered on (or null). Tagged onto
  // its node so the stylesheet can give it an accent border.
  function elements(d, focus) {
    const fnorm = focus ? (focus[0] === "@" ? focus : "@" + focus) : null;
    const nodes = (d.nodes || []).map((n) => ({ data: { id: n.id, label: n.label, status: n.status, focus: fnorm && n.id === fnorm ? "1" : "0" } }));
    const edges = (d.edges || []).map((e, i) => ({ data: { id: "e" + i, source: e.source, target: e.target, kind: e.kind } }));
    return nodes.concat(edges);
  }
  function style() {
    return [
      { selector: "node", style: {
        "background-color": EF.bg, "border-width": 1.5, "border-color": EF.edge,
        shape: "round-rectangle", width: 168, height: 50, label: "data(label)",
        color: EF.ink, "font-size": 11, "text-wrap": "wrap", "text-max-width": 150,
        "text-valign": "center", "text-halign": "center", padding: 8 } },
      ...Object.entries(STATUS).map(([s, c]) => ({ selector: `node[status = "${s}"]`, style: { "border-color": c, "border-width": 2 } })),
      { selector: "edge", style: {
        width: 1.5, "line-color": EF.muted, "target-arrow-color": EF.muted,
        "target-arrow-shape": "triangle", "arrow-scale": 0.9, "curve-style": "bezier" } },
      { selector: 'edge[kind = "part_of"]', style: { "line-color": EF.purple, "target-arrow-color": EF.purple, "line-style": "dashed" } },
      // focus last so its accent border wins over the per-status border.
      { selector: 'node[focus = "1"]', style: { "border-color": EF.accent, "border-width": 4 } },
    ];
  }

  window.tern = window.tern || {};

  // focus (optional) = an @id; when set, fetch the focused subgraph around it and
  // accent that node. Absent → full DAG, identical to before.
  window.tern.mountGraph = async function ({ el, focus }) {
    if (!el || typeof cytoscape === "undefined") return;
    el.style.width = "100%";
    el.style.height = el.style.height || "420px";
    const url = focus ? "/api/dag?focus=" + encodeURIComponent(focus) : "/api/dag";
    let data;
    try { data = await fetch(url).then((r) => r.json()); } catch (_) { return; }
    cytoscape({
      container: el,
      elements: elements(data, focus),
      style: style(),
      layout: { name: "breadthfirst", directed: true, spacingFactor: 1.3, padding: 24, animate: false },
      wheelSensitivity: 0.2, minZoom: 0.2, maxZoom: 2.5,
    });
  };
})();

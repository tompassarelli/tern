// Thread-DAG renderer — Cytoscape mounted into #cy, fed by /api/dag.
// Exposed as window.mountDag(elId); a Hologram on-mount action calls it (so it
// runs after hydration, not racing it). Seamless pan/zoom/drag come free from
// Cytoscape. Everforest palette to match the desktop.

(function () {
  const EVERFOREST = {
    bg: "#272e33",
    edge: "#414b50",
    ink: "#d3c6aa",
    muted: "#859289",
    accent: "#7fbbb3",
    star: "#dbbc7f",
    ok: "#a7c080",
    warn: "#e67e80",
    purple: "#d699b6",
  };

  const STATUS_COLOR = {
    active: EVERFOREST.star,
    blocked: EVERFOREST.warn,
    ready: EVERFOREST.accent,
    backlog: EVERFOREST.muted,
  };

  let cy = null;

  function toElements(data) {
    const nodes = (data.nodes || []).map((n) => ({
      data: { id: n.id, label: n.label, status: n.status, driver: n.driver || "" },
    }));
    const edges = (data.edges || []).map((e, i) => ({
      data: { id: "e" + i, source: e.source, target: e.target, kind: e.kind },
    }));
    return nodes.concat(edges);
  }

  function style() {
    return [
      {
        selector: "node",
        style: {
          "background-color": EVERFOREST.bg,
          "border-width": 1.5,
          "border-color": EVERFOREST.edge,
          shape: "round-rectangle",
          width: 168,
          height: 52,
          label: "data(label)",
          color: EVERFOREST.ink,
          "font-size": 11,
          "font-family": "ui-sans-serif, system-ui, sans-serif",
          "text-wrap": "wrap",
          "text-max-width": 150,
          "text-valign": "center",
          "text-halign": "center",
          padding: 8,
        },
      },
      ...Object.entries(STATUS_COLOR).map(([st, col]) => ({
        selector: `node[status = "${st}"]`,
        style: { "border-color": col, "border-width": 2 },
      })),
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": EVERFOREST.muted,
          "target-arrow-color": EVERFOREST.muted,
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.9,
          "curve-style": "bezier",
        },
      },
      {
        selector: 'edge[kind = "part_of"]',
        style: { "line-color": EVERFOREST.purple, "target-arrow-color": EVERFOREST.purple, "line-style": "dashed" },
      },
    ];
  }

  async function mountDag(elId) {
    const el = document.getElementById(elId);
    if (!el || typeof cytoscape === "undefined") return;

    let data;
    try {
      data = await fetch("/api/dag").then((r) => r.json());
    } catch (_) {
      return;
    }

    if (cy) {
      cy.json({ elements: toElements(data) });
      cy.layout(layoutOpts()).run();
      return;
    }

    cy = cytoscape({
      container: el,
      elements: toElements(data),
      style: style(),
      layout: layoutOpts(),
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 2.5,
    });
  }

  function layoutOpts() {
    return {
      name: "breadthfirst",
      directed: true,
      spacingFactor: 1.3,
      padding: 24,
      animate: false,
    };
  }

  window.mountDag = mountDag;
})();

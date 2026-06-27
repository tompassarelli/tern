defmodule LodestarWeb.WorkbenchPage do
  use Hologram.Page
  use Hologram.JS

  route "/"
  layout LodestarWeb.MainLayout

  def init(_params, component, _server) do
    roster = Lodestar.Presence.roster()

    component
    |> put_state(agents: roster, fleet: Lodestar.Presence.fleet_tokens(roster))
    |> put_action(:mount_graph)
  end

  # Runs after the page mounts client-side → mounts Cytoscape into #cy (it
  # fetches /api/dag itself). Firing from on-mount avoids racing hydration.
  def action(:mount_graph, _params, component) do
    JS.exec("window.mountDag && window.mountDag('cy')")
    component
  end

  def template do
    ~HOLO"""
    <div class="app">
      <section class="panel">
        <div class="pane-title">work bench</div>
        <div class="pane-content"><div id="cy" class="cy"></div></div>
        <div class="cli-box">
          <span class="cli-tag">ultracode</span>
          <span class="cli-prompt">&gt;</span> <span class="cli-ph">cli</span>
        </div>
        <div class="statusline">
          <span class="toggle">View: Board</span>
          <span class="toggle">Types: Threads</span>
        </div>
      </section>

      <section class="panel">
        <div class="pane-title">agent chat</div>
        <div class="pane-content agent-list">
          {%for a <- @agents}
            <div class="agent-row">
              <span class={if a.online do "agent-dot on" else "agent-dot off" end}></span>
              <div class="agent-main">
                <div class="agent-id">{a.uuid}</div>
                {%if a.focus_str != ""}
                  <div class="agent-focus">{a.focus_str}</div>
                {/if}
              </div>
              <div class="agent-meta">
                {%if a.model_str != ""}<span class="agent-model">{a.model_str}</span>{/if}
                <span class="agent-ctx">{a.ctx_str} ctx</span>
              </div>
            </div>
          {/for}
        </div>
        <div class="cli-box">
          <span class="cli-tag">ultracode</span>
          <span class="cli-prompt">&gt;</span> <span class="cli-ph">cli</span>
        </div>
        <div class="statusline">
          <span class="badge">auto</span>
          <span>auto mode on · {length(@agents)} agents</span>
          <span class="status-tok">{@fleet.context} ctx · {@fleet.total} all-time</span>
        </div>
      </section>
    </div>
    """
  end
end

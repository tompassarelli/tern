defmodule LodestarWeb.WorkbenchPage do
  use Hologram.Page
  use Hologram.JS

  route "/"
  layout LodestarWeb.MainLayout

  @tips [
    "A thread is just an id with a title — capture a thought and it becomes a unit of work.",
    "Lifecycle isn't a status field; it's derived from your claims — committed, outcome, driver, depends_on.",
    "Every fact is a subject-predicate-object triple — you never edit a row, you assert a new claim.",
    "Don't mark something done; tell the thread its outcome and let the engine derive the rest.",
    "Reference another thread with @id; everything else is a literal value.",
    "Blocked? Add a depends_on edge — the DAG figures out what's actually ready.",
    "Run ready / next / plate to let the substrate tell you what to work on.",
    "Dispatch an agent against a thread and it reads the claims to derive its own posture.",
    "needs-review surfaces judgments whose inputs moved: stale estimates, expired dates, dead edges.",
    "Clock start/stop logs real time so your estimates calibrate against actuals.",
    "Watch the ctx budget — a thread that won't fit is a thread that needs decomposing.",
    "The kanban is a projection; the claim graph is the source of truth, always queryable."
  ]

  # class bundles as functions — in HOLO templates `@x` is STATE access, so a
  # module attribute can't be referenced as `{@x}`; a 0-arity call can.
  defp panel_cls, do: "flex flex-col min-h-0 border border-edge rounded-2xl p-4"
  defp title_cls, do: "text-muted text-[13px] tracking-wide lowercase mb-2.5"
  defp cli_cls, do: "relative mt-3 border border-edge rounded-[10px] px-3 py-2.5 font-mono text-[13px] flex items-center gap-1.5"
  defp cli_tag_cls, do: "absolute -top-2 right-3.5 bg-panel px-2 text-[11px] text-accent-alt"
  defp status_cls, do: "flex items-center gap-2.5 mt-2 font-mono text-xs text-muted flex-wrap"
  defp dot_cls(true), do: "w-[7px] h-[7px] rounded-full shrink-0 bg-ok"
  defp dot_cls(false), do: "w-[7px] h-[7px] rounded-full shrink-0 bg-muted opacity-40"

  def init(_params, component, server) do
    roster = Lodestar.Presence.roster()
    selected = roster |> List.first() |> then(&(&1 && &1.uuid))

    component =
      put_state(component,
        agents: roster,
        fleet: Lodestar.Presence.fleet_tokens(roster),
        selected: selected,
        messages: if(selected, do: Lodestar.Stream.messages(selected), else: []),
        active: active_info(roster, selected),
        tip: Enum.random(@tips),
        view: "board",
        board: Lodestar.Threads.board(),
        synced: 0
      )

    # Live push: subscribe to each daemon's commit channel. The DaemonSubscriber
    # GenServers broadcast :daemon_changed on every commit → no polling.
    server =
      server
      |> put_subscription({:graph, "agents"})
      |> put_subscription({:graph, "board"})

    {component, server}
  end

  # thinking-indicator info for the selected agent (only when it's live + working)
  defp active_info(agents, selected) do
    case Enum.find(agents, &(&1.uuid == selected)) do
      %{thinking: true} = r -> %{thinking: true, elapsed: r.elapsed_str, ctx: r.ctx_str}
      _ -> %{thinking: false, elapsed: "", ctx: ""}
    end
  end

  def action(:mount_graph, _params, component) do
    JS.exec("window.mountDag && window.mountDag('cy')")
    component
  end

  # Board (kanban) ⇄ Graph (DAG). Switching to graph mounts Cytoscape after the
  # #cy element has rendered (small delay), since it only exists in graph view.
  def action(:toggle_view, _params, component) do
    next = if component.state.view == "graph", do: "board", else: "graph"
    component = put_state(component, :view, next)
    if next == "graph", do: put_action(component, name: :mount_graph, delay: 60), else: component
  end

  def action(:select_agent, params, component), do: select(component, params.uuid)
  def action(:cycle_agent, _params, component), do: select(component, step(component, +1))
  def action(:nav_down, _params, component), do: select(component, step(component, +1))
  def action(:nav_up, _params, component), do: select(component, step(component, -1))

  def command(:load_stream, params, server),
    do: put_action(server, :apply_stream, messages: Lodestar.Stream.messages(params.agent))

  def action(:apply_stream, params, component),
    do: put_state(component, :messages, params.messages)

  # ── live push from the daemon subscribers (no polling) ──
  def action(:daemon_changed, params, component) do
    case params.graph do
      "agents" -> put_command(component, :reload_agents)
      "board" -> put_command(component, :reload_board)
      _ -> component
    end
  end

  def command(:reload_agents, _params, server) do
    roster = Lodestar.Presence.roster()
    put_action(server, :apply_agents, agents: roster, fleet: Lodestar.Presence.fleet_tokens(roster))
  end

  def command(:reload_board, _params, server),
    do: put_action(server, :apply_board, board: Lodestar.Threads.board())

  def action(:apply_agents, params, component) do
    component
    |> put_state(agents: params.agents, fleet: params.fleet)
    |> put_state(:active, active_info(params.agents, component.state.selected))
    |> put_state(:synced, component.state.synced + 1)
  end

  def action(:apply_board, params, component) do
    component = put_state(component, board: params.board, synced: component.state.synced + 1)
    if component.state.view == "graph", do: put_action(component, :mount_graph), else: component
  end

  defp select(component, nil), do: component

  defp select(component, uuid) do
    component
    |> put_state(selected: uuid, active: active_info(component.state.agents, uuid))
    |> put_command(:load_stream, agent: uuid)
  end

  defp step(component, delta) do
    ids = Enum.map(component.state.agents, & &1.uuid)

    case ids do
      [] -> nil
      _ ->
        i = Enum.find_index(ids, &(&1 == component.state.selected)) || 0
        Enum.at(ids, Integer.mod(i + delta, length(ids)))
    end
  end

  def template do
    ~HOLO"""
    <window $key_down.shift+tab.prevent_default="cycle_agent" />
    <window $key_down.arrow_down="nav_down" />
    <window $key_down.arrow_up="nav_up" />

    <div class="grid grid-cols-2 gap-4 p-4 h-screen">
      <section class={panel_cls()} data-testid="panel">
        <div class={title_cls()}>work bench</div>
        <div class="flex-1 min-h-0 overflow-hidden" data-testid="workarea">
          {%if @view == "graph"}
            <div id="cy" class="w-full h-full"></div>
          {%else}
            <div class="flex gap-3 h-full" data-testid="kanban">
              {%for lane <- @board.lanes}
                <div class="flex flex-col gap-2 flex-1 min-w-0 min-h-0">
                  <div class="text-[11px] uppercase tracking-wide text-muted flex items-center gap-2">
                    {lane.label} <span class="text-star">{length(lane.cards)}</span>
                  </div>
                  <div class="flex flex-col gap-2 overflow-y-auto">
                    {%for c <- lane.cards}
                      <div class={"border border-edge rounded-lg p-2 text-xs " <> card_cls(c.status)}>
                        <div class="text-ink leading-snug">{c.label}</div>
                        {%if c.driver}<div class="text-accent font-mono text-[10px] mt-1">{"@" <> c.driver}</div>{/if}
                      </div>
                    {/for}
                    {%if lane.cards == []}<div class="text-muted text-[11px] italic">—</div>{/if}
                  </div>
                </div>
              {/for}
            </div>
          {/if}
        </div>
        <div class={cli_cls()}>
          <span class={cli_tag_cls()}>ultracode</span>
          <span class="text-accent">&gt;</span> <span class="text-muted">cli</span>
        </div>
        <div class={status_cls()}>
          <span class="border border-edge rounded-md px-2 py-0.5 text-ink text-[11px] cursor-pointer hover:border-accent" data-testid="view-toggle" $click="toggle_view">View: {view_label(@view)}</span>
          <span class="border border-edge rounded-md px-2 py-0.5 text-ink text-[11px]">Types: Threads</span>
        </div>
      </section>

      <section class={panel_cls()} data-testid="panel">
        <div class={title_cls()}>agent chat{%if @selected} · {@selected}{/if}</div>

        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2" data-testid="chat">
          {%for m <- @messages}
            <div class={"text-[13px] leading-snug max-w-full break-words whitespace-pre-wrap " <> msg_cls(m.kind)}>{m.text}</div>
          {/for}
          {%if @messages == []}
            <div class="h-full flex items-center justify-center text-muted">no activity</div>
          {/if}
        </div>

        {%if @active.thinking}
          <div data-testid="thinking" class="mt-2 font-mono text-xs">
            <div class="text-star">✦ Deliberating… ({@active.elapsed} · ↑{@active.ctx} tokens)</div>
            <div class="text-muted mt-0.5">Tip: {@tip}</div>
          </div>
        {/if}

        <div class={cli_cls()}>
          <span class={cli_tag_cls()}>ultracode</span>
          <span class="text-accent">&gt;</span> <span class="text-muted">cli</span>
        </div>

        <div class="flex flex-col gap-px mt-2 max-h-40 overflow-y-auto">
          {%for a <- @agents}
            <div class={"flex items-center gap-2 px-2 py-1 rounded-md text-xs cursor-pointer hover:bg-white/[0.03] " <> if(a.uuid == @selected, do: "bg-accent-alt/10", else: "")} data-testid="pick-row" data-sel={if a.uuid == @selected do "1" else "0" end} $click={:select_agent, uuid: a.uuid}>
              {%if a.uuid == @selected}<span class="text-accent-alt">*</span>{/if}
              <span class={dot_cls(a.online)}></span>
              <span class="font-mono text-ink shrink-0">{a.uuid}</span>
              {%if a.focus_str != ""}<span class="text-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{a.focus_str}</span>{/if}
              <span class="text-star font-mono text-[11px] shrink-0 ml-auto">{a.ctx_str} ctx</span>
            </div>
          {/for}
        </div>

        <div class={status_cls()}>
          <span class="bg-star text-bg px-1.5 py-px rounded text-[11px] font-semibold">auto</span>
          <span>auto mode on · {length(@agents)} agents</span>
          <span class="text-ok" data-testid="synced" title="live pushes received">●&nbsp;{@synced}</span>
          <span class="ml-auto text-star">{@fleet.context} ctx · {@fleet.total} all-time</span>
        </div>
      </section>
    </div>
    """
  end

  defp msg_cls("tool"), do: "text-accent font-mono text-[11px] bg-accent/10 rounded-[5px] px-1.5 py-0.5 self-start"
  defp msg_cls("result"), do: "text-ok border-l-2 border-ok pl-2"
  defp msg_cls(_), do: "text-ink"

  defp card_cls("active"), do: "border-l-2 border-l-star"
  defp card_cls("blocked"), do: "border-l-2 border-l-warn"
  defp card_cls("ready"), do: "border-l-2 border-l-accent"
  defp card_cls(_), do: "border-l-2 border-l-muted"

  defp view_label("graph"), do: "Graph"
  defp view_label(_), do: "Board"
end

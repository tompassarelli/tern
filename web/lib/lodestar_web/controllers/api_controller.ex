defmodule LodestarWeb.ApiController do
  use LodestarWeb, :controller

  # Cytoscape-ready thread DAG from the board daemon (:7977).
  def dag(conn, _params), do: json(conn, Lodestar.Threads.graph())

  # Claim-derived list view: threads grouped by lifecycle (in-progress/ready/
  # blocked/backlog/draft), ready ordered by do_on so the top row is "next".
  def list(conn, _params), do: json(conn, Lodestar.Threads.list())

  # Kanban lanes (derived status) for the board view.
  def board(conn, _params), do: json(conn, Lodestar.Threads.board())

  # Live agent roster for the agents panel.
  def agents(conn, _params), do: json(conn, %{agents: Lodestar.Presence.roster()})

  # Chat stream for one agent (from ~/code/agent-data/agent-<h>.stream.jsonl).
  def agent_stream(conn, %{"handle" => h}), do: json(conn, %{handle: h, messages: Lodestar.Stream.messages(h)})

  # Generic claims read for wake's `persist :feed`: flat entity rows (id = the
  # claim ref, so writes target the right subject) for a graph. Board for now.
  def entities(conn, params) do
    rows =
      case Map.get(params, "graph", "board") do
        "board" ->
          Lodestar.Threads.graph().nodes
          |> Enum.map(fn n -> %{id: n.id, title: n.label, status: n.status, driver: n.driver || ""} end)

        _ ->
          []
      end

    json(conn, rows)
  end

  # Live agent roster + fleet token totals from the agents daemon (:7978).
  def presence(conn, _params) do
    roster = Lodestar.Presence.roster()
    json(conn, %{agents: roster, fleet: Lodestar.Presence.fleet_tokens(roster)})
  end

  # Flat array in the shape wake's agents.wake `(entity agent …)` expects
  # (all string fields). This is what wake's `persist :feed` snapshots.
  def wake_presence(conn, _params) do
    rows =
      Lodestar.Presence.roster()
      |> Enum.map(fn r ->
        %{
          uuid: r.uuid,
          roles: r.roles_str,
          model: r.model_str,
          online: if(r.online, do: "online", else: "offline"),
          current_thread: r.current_thread || "",
          active_workflow: r.active_workflow || "",
          cost_usd: r.ctx_str
        }
      end)

    json(conn, rows)
  end

  # ── claim writes (backend owns OCC/versioning; the browser just states facts) ──

  # Raw substrate op: assert a claim (te p r) on a graph.
  def assert(conn, %{"graph" => g, "te" => te, "p" => p, "r" => r}) do
    write_resp(conn, Lodestar.Fram.assert!(Lodestar.Fram.port_for(g), te, p, r))
  end

  def retract(conn, %{"graph" => g, "te" => te, "p" => p, "r" => r}) do
    write_resp(conn, Lodestar.Fram.retract!(Lodestar.Fram.port_for(g), te, p, r))
  end

  # Higher-level claim-native verb (lodestar `tell`): one fact about an entity.
  # Normalizes the @ on the subject; the engine decides assert-vs-supersede.
  def tell(conn, %{"graph" => g, "id" => id, "pred" => pred, "obj" => obj}) do
    te = if String.starts_with?(id, "@"), do: id, else: "@" <> id
    write_resp(conn, Lodestar.Fram.assert!(Lodestar.Fram.port_for(g), te, pred, obj))
  end

  # Capture a new thread (lodestar `capture`): mint a timestamp id + assert its
  # title. A thread IS any id with a title; it derives as "draft" until committed.
  def capture(conn, %{"title" => title} = params) when is_binary(title) and title != "" do
    graph = Map.get(params, "graph", "board")
    id = "@" <> Calendar.strftime(DateTime.utc_now(), "%Y-%m-%d-%H%M%S")

    case Lodestar.Fram.assert!(Lodestar.Fram.port_for(graph), id, "title", title) do
      {:ok, v} -> json(conn, %{ok: v, id: id})
      other -> write_resp(conn, other)
    end
  end

  def capture(conn, _), do: conn |> put_status(400) |> json(%{error: "title required"})

  # Steer an agent from the agents-panel "›": write a steer claim on the agent's
  # session (agents daemon). The agent's loop can pick it up.
  def steer(conn, %{"handle" => h, "text" => text}) when is_binary(h) and is_binary(text) and text != "" do
    write_resp(conn, Lodestar.Fram.assert!(Lodestar.Fram.agents_port(), "@session:" <> h, "steer", text))
  end

  def steer(conn, _), do: conn |> put_status(400) |> json(%{error: "handle + text required"})

  defp write_resp(conn, {:ok, v}), do: json(conn, %{ok: v})
  defp write_resp(conn, {:conflict, _}), do: conn |> put_status(409) |> json(%{conflict: true})
  defp write_resp(conn, {:error, reason}), do: conn |> put_status(502) |> json(%{error: to_string(reason)})

  # wake's sibling /live WebSocket — upgrade + hand off to LiveFeed (PubSub-fed).
  def live(conn, _params) do
    conn
    |> WebSockAdapter.upgrade(LodestarWeb.LiveFeed, [], timeout: 120_000)
    |> halt()
  end

  # Thin everforest scrollbars EVERYWHERE — no native chunky/arrow scrollbars.
  # Injected into every shell's <style>; unscoped so it catches every scroll box.
  @scrollbar_css "*{scrollbar-width:thin;scrollbar-color:#414b50 transparent}" <>
                   "::-webkit-scrollbar{width:8px;height:8px}" <>
                   "::-webkit-scrollbar-track{background:transparent}" <>
                   "::-webkit-scrollbar-thumb{background:#414b50;border-radius:4px}" <>
                   "::-webkit-scrollbar-thumb:hover{background:#859289}" <>
                   "::-webkit-scrollbar-button{display:none;height:0;width:0}" <>
                   "::-webkit-scrollbar-corner{background:transparent}"

  # The wake frontend shell: mounts the compiled wake bundle into #app, with
  # Cytoscape + the escape-hatch mounts. The wake app self-feeds via /presence
  # + /live. (Lives at /wake while we prove the stack; flips to / when ready.)
  @wake_shell """
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>lodestar</title>
    <link rel="stylesheet" href="/assets/css/app.css" />
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#app{height:100vh;overflow:auto}#{@scrollbar_css}</style>
    <script src="/js/cytoscape.min.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script src="/js/wake-mounts.js"></script>
    <script src="/js/lodestar-ui.js"></script>
  </body>
  </html>
  """

  def wake_shell(conn, _params) do
    conn
    |> put_resp_content_type("text/html")
    |> send_resp(200, @wake_shell)
  end

  # Claims-native write demo: board threads with a `(tell …)` action button.
  # Proves the round-trip click → /api/tell → daemon commit → /live → re-fetch.
  @board_shell """
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>lodestar · board write</title>
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#app{height:100vh;overflow:auto}.border-border{border-color:#414b50}.text-foreground{color:#d3c6aa}.text-muted-foreground{color:#859289}#{@scrollbar_css}</style>
    <script>window.WAKE_GRAPH = "board";</script>
  </head>
  <body>
    <div id="app"></div>
    <script src="/js/board-write.js"></script>
  </body>
  </html>
  """

  def wake_board(conn, _params) do
    conn |> put_resp_content_type("text/html") |> send_resp(200, @board_shell)
  end

  # Claims-native list view — threads grouped by derived lifecycle, live.
  @list_shell """
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>lodestar · list</title>
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#{@scrollbar_css}</style>
  </head>
  <body>
    <div id="list"></div>
    <script src="/js/lodestar-list.js"></script>
  </body>
  </html>
  """

  def list_view(conn, _params) do
    conn |> put_resp_content_type("text/html") |> send_resp(200, @list_shell)
  end

  # Minimal shell that mounts ONE renderer into a root div. Both board + agents
  # boot the same way; the renderer self-fetches + self-refreshes.
  defp shell(title, root_id, js) do
    """
    <!doctype html>
    <html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>lodestar · #{title}</title>
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#{@scrollbar_css}</style>
    </head><body><div id="#{root_id}"></div><script src="#{js}"></script></body></html>
    """
  end

  def board_view(conn, _params),
    do: conn |> put_resp_content_type("text/html") |> send_resp(200, shell("board", "board", "/js/lodestar-board.js"))

  def agents_view(conn, _params),
    do: conn |> put_resp_content_type("text/html") |> send_resp(200, shell("agents", "agents", "/js/lodestar-agents.js"))

  # The full 2-panel client (workbench + agents). Loads every renderer; the
  # orchestrator (lodestar-app.js, last) lays out the frames + view toggle.
  @app_shell """
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>lodestar</title>
    <script>window.WAKE_GRAPH = "board";</script>
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}#{@scrollbar_css}</style>
    <script src="/js/cytoscape.min.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script src="/js/wake-mounts.js"></script>
    <script src="/js/lodestar-list.js"></script>
    <script src="/js/lodestar-board.js"></script>
    <script src="/js/lodestar-agents.js"></script>
    <script src="/js/lodestar-app.js"></script>
  </body>
  </html>
  """

  def app_view(conn, _params),
    do: conn |> put_resp_content_type("text/html") |> send_resp(200, @app_shell)
end

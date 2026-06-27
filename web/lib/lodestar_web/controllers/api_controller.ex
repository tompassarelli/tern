defmodule LodestarWeb.ApiController do
  use LodestarWeb, :controller

  # Cytoscape-ready thread DAG from the board daemon (:7977).
  def dag(conn, _params), do: json(conn, Lodestar.Threads.graph())

  # Claim-derived list view: threads grouped by lifecycle (in-progress/ready/
  # blocked/backlog/draft), ready ordered by do_on so the top row is "next".
  def list(conn, _params), do: json(conn, Lodestar.Threads.list())

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

  defp write_resp(conn, {:ok, v}), do: json(conn, %{ok: v})
  defp write_resp(conn, {:conflict, _}), do: conn |> put_status(409) |> json(%{conflict: true})
  defp write_resp(conn, {:error, reason}), do: conn |> put_status(502) |> json(%{error: to_string(reason)})

  # wake's sibling /live WebSocket — upgrade + hand off to LiveFeed (PubSub-fed).
  def live(conn, _params) do
    conn
    |> WebSockAdapter.upgrade(LodestarWeb.LiveFeed, [], timeout: 120_000)
    |> halt()
  end

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
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#app{height:100vh;overflow:auto}</style>
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
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}#app{height:100vh;overflow:auto}.border-border{border-color:#414b50}.text-foreground{color:#d3c6aa}.text-muted-foreground{color:#859289}</style>
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
    <style>html,body{margin:0;height:100%;background:#272e33;color:#d3c6aa;font-family:ui-sans-serif,system-ui,sans-serif}</style>
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
end

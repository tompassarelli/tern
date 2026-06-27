defmodule LodestarWeb.ApiController do
  use LodestarWeb, :controller

  # Cytoscape-ready thread DAG from the board daemon (:7977).
  def dag(conn, _params), do: json(conn, Lodestar.Threads.graph())

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

  # wake's sibling /live WebSocket — upgrade + hand off to LiveFeed (PubSub-fed).
  def live(conn, _params) do
    conn
    |> WebSockAdapter.upgrade(LodestarWeb.LiveFeed, [], timeout: 120_000)
    |> halt()
  end
end

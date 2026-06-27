defmodule LodestarWeb.ApiController do
  use LodestarWeb, :controller

  # Cytoscape-ready thread DAG from the board daemon (:7977).
  def dag(conn, _params), do: json(conn, Lodestar.Threads.graph())

  # Live agent roster + fleet token totals from the agents daemon (:7978).
  def presence(conn, _params) do
    roster = Lodestar.Presence.roster()
    json(conn, %{agents: roster, fleet: Lodestar.Presence.fleet_tokens(roster)})
  end
end

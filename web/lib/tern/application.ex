defmodule Tern.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      TernWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:tern, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Tern.PubSub},
      # One supervised subscriber per fram daemon — the live commit→push spine.
      Supervisor.child_spec({Tern.DaemonSubscriber, name: :sub_agents, graph: "agents", port: 7977}, id: :sub_agents),
      Supervisor.child_spec({Tern.DaemonSubscriber, name: :sub_board, graph: "board", port: 7977}, id: :sub_board),
      # Materialized board-graph fold; refreshed on commit (off the request path).
      Tern.GraphCache,
      # Start to serve requests, typically the last entry
      TernWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Tern.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    TernWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end

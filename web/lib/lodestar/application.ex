defmodule Lodestar.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      LodestarWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:lodestar, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Lodestar.PubSub},
      # One supervised subscriber per fram daemon — the live commit→push spine.
      Supervisor.child_spec({Lodestar.DaemonSubscriber, name: :sub_agents, graph: "agents", port: 7978}, id: :sub_agents),
      Supervisor.child_spec({Lodestar.DaemonSubscriber, name: :sub_board, graph: "board", port: 7977}, id: :sub_board),
      # Start to serve requests, typically the last entry
      LodestarWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Lodestar.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    LodestarWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end

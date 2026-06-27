defmodule LodestarWeb.LiveFeed do
  @moduledoc """
  Raw WebSocket for wake's `persist :feed` — wake opens a sibling `/live` socket
  and re-fetches `/presence` on every message we push. We push one frame per
  daemon commit, fed by the DaemonSubscriber → PubSub "wakefeed" topic.

  Framework-agnostic edge: this is the OTP realtime spine surfaced as a plain
  WebSocket, independent of Hologram. Any frontend (wake here) can consume it.
  """

  @behaviour WebSock

  @impl true
  def init(_opts) do
    Phoenix.PubSub.subscribe(Lodestar.PubSub, "wakefeed")
    {:ok, %{}}
  end

  @impl true
  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info({:commit, graph}, state), do: {:push, {:text, graph}, state}
  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end

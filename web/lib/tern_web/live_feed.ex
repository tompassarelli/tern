defmodule TernWeb.LiveFeed do
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
    Phoenix.PubSub.subscribe(Tern.PubSub, "wakefeed")
    {:ok, %{}}
  end

  @impl true
  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  # Coarse commit frame: bare graph name as text (back-compat — wake re-fetches).
  def handle_info({:commit, graph}, state), do: {:push, {:text, graph}, state}

  # Per-claim delta frame: JSON so the client can patch in place without re-fetch.
  def handle_info({:delta, graph, d}, state) do
    frame =
      Jason.encode!(%{t: "delta", graph: graph, op: d.op, l: d.l, p: d.p, r: d.r})

    {:push, {:text, frame}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end

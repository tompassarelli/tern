defmodule Tern.DaemonSubscriber do
  @moduledoc """
  The BEAM-native heart of live updates: one supervised, long-lived process per
  fram daemon, holding a persistent `:subscribe` TCP connection to the commit
  stream. On every commit it broadcasts on PubSub "wakefeed" to subscribed
  clients (via Phoenix.PubSub) — true push, no polling. Crashes/disconnects are
  handled by reconnecting; the supervisor restarts us if we die.

  This is where "abuse the BEAM" actually lands: cheap always-on processes +
  PubSub fan-out + fault-tolerance, independent of the frontend framework.
  """

  use GenServer
  require Logger

  @host ~c"127.0.0.1"
  @reconnect_ms 2_000

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.fetch!(opts, :name))
  end

  @impl true
  def init(opts) do
    state = %{port: Keyword.fetch!(opts, :port), graph: Keyword.fetch!(opts, :graph), sock: nil}
    {:ok, state, {:continue, :connect}}
  end

  @impl true
  def handle_continue(:connect, state), do: {:noreply, connect(state)}

  @impl true
  def handle_info(:reconnect, state), do: {:noreply, connect(state)}

  def handle_info({:tcp, sock, line}, state) do
    :inet.setopts(sock, active: :once)
    if String.contains?(line, ":commit") do
      # coarse + robust: any commit on this daemon = "this graph changed".
      # Clients can re-fetch the affected view off this alone (back-compat).
      # Raw PubSub drives the wake /live WebSocket feed (framework-agnostic edge).
      Phoenix.PubSub.broadcast(Tern.PubSub, "wakefeed", {:commit, state.graph})
      # Best-effort: decode the per-claim delta the daemon already emits and
      # broadcast it too, so clients can patch in place instead of re-fetching.
      # A malformed/partial line leaves the coarse path above untouched.
      broadcast_delta(line, state.graph)
    end

    {:noreply, state}
  end

  def handle_info({:tcp_closed, _sock}, state), do: {:noreply, schedule_reconnect(state)}
  def handle_info({:tcp_error, _sock, _reason}, state), do: {:noreply, schedule_reconnect(state)}
  def handle_info(_other, state), do: {:noreply, state}

  # EDN-decode the commit line — {:event :commit :version V :op "assert"|"retract"
  # :l <subj> :p <pred> :r <obj>} — and emit a {:delta, graph, %{op,l,p,r}} on the
  # same topic. Eden.decode! raises on a malformed/empty line; any failure (or a
  # commit shape missing the claim fields) silently falls back to the coarse path.
  defp broadcast_delta(line, graph) do
    case Eden.decode!(line) do
      %{op: op, l: l, p: p, r: r} ->
        Phoenix.PubSub.broadcast(
          Tern.PubSub,
          "wakefeed",
          {:delta, graph, %{op: op, l: l, p: p, r: r}}
        )

      _ ->
        :ok
    end
  rescue
    _ -> :ok
  end

  defp connect(state) do
    opts = [:binary, active: :once, packet: :line, recbuf: 1_000_000]

    case :gen_tcp.connect(@host, state.port, opts, 2_000) do
      {:ok, sock} ->
        :gen_tcp.send(sock, "{:op :subscribe}\n")
        Logger.info("DaemonSubscriber[#{state.graph}] subscribed on :#{state.port}")
        %{state | sock: sock}

      {:error, reason} ->
        Logger.warning("DaemonSubscriber[#{state.graph}] connect failed (#{inspect(reason)}); retrying")
        schedule_reconnect(state)
    end
  end

  defp schedule_reconnect(state) do
    Process.send_after(self(), :reconnect, @reconnect_ms)
    %{state | sock: nil}
  end
end

defmodule Tern.GraphCache do
  @moduledoc """
  Materialized cache of the board graph fold. The cost in the request path was
  all_triples → 1.67MB EDN over TCP → ~1.5s of pure-Elixir `eden` decode, paid on
  EVERY /api/* call (incl. 4s/15s polls + every view switch). The graph only
  changes on a commit, and DaemonSubscriber already broadcasts those on the
  "wakefeed" PubSub topic — so fold ONCE, serve every view from the cache, and
  refresh in the BACKGROUND on commit. Reads drop from ~1.7s to ~0ms; the decode
  moves off the request path. (SQL-equivalent: a materialized view, recomputed on
  write.)
  """
  use GenServer
  alias Tern.Fram

  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc "Cached fold {node_attrs, edges} for the board graph (computes on first miss)."
  def fold(port \\ nil), do: GenServer.call(__MODULE__, {:fold, port || Fram.board_port()}, 20_000)

  @impl true
  def init(_) do
    Phoenix.PubSub.subscribe(Tern.PubSub, "wakefeed")
    {:ok, %{fold: nil, port: Fram.board_port()}}
  end

  @impl true
  def handle_call({:fold, port}, _from, %{fold: nil} = st),
    do: (f = Tern.Threads.fold_triples(port); {:reply, f, %{st | fold: f, port: port}})

  def handle_call({:fold, _port}, _from, %{fold: f} = st), do: {:reply, f, st}

  @impl true
  # A board commit invalidated the materialization — recompute OFF the GenServer
  # (so reads keep serving the prior fold during the ~1.5s decode), then swap in.
  def handle_info({:commit, "board"}, st) do
    me = self()
    port = st.port
    Task.start(fn -> send(me, {:set, Tern.Threads.fold_triples(port)}) end)
    {:noreply, st}
  end

  def handle_info({:set, f}, st), do: {:noreply, %{st | fold: f}}
  def handle_info(_, st), do: {:noreply, st}
end

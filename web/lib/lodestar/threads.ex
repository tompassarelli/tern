defmodule Lodestar.Threads do
  @moduledoc """
  Thread DAG for the left panel. Folds the board daemon (:7977) claim graph into
  title-bearing thread nodes + dependency edges, derives lifecycle from claims,
  and scopes to the open structural frontier. Layout/pan/zoom is Cytoscape's job
  (client-side) — this just provides the graph data.

  Ports board.js deriveCol + bridge.clj fold-tuple. Server-side.
  """

  alias Lodestar.Fram

  # depends_on/part_of form the directed backbone; relates_to is excluded (627
  # soft links = visual noise).
  @dag_preds ~w(depends_on part_of)
  @max_nodes 60

  @doc "%{nodes: [%{id,label,status,driver}], edges: [%{source,target,kind}]} — Cytoscape-ready."
  def graph(port \\ nil) do
    port = port || Fram.board_port()
    {node_attrs, edges} = fold(Fram.all_triples(port))

    titled = for {id, attrs} <- node_attrs, Map.get(attrs, "title", "") != "", into: %{}, do: {id, attrs}
    by_from = Enum.group_by(edges, & &1.from)
    status = Map.new(titled, fn {id, attrs} -> {id, derive_status(attrs, Map.get(by_from, id, []), node_attrs)} end)

    open = titled |> Map.keys() |> Enum.reject(&(status[&1] in ["done", "abandoned"])) |> MapSet.new()

    dedges =
      edges
      |> Enum.filter(&(&1.pred in @dag_preds))
      |> Enum.filter(&(MapSet.member?(open, &1.from) and MapSet.member?(open, &1.to)))

    in_edge = dedges |> Enum.flat_map(&[&1.from, &1.to]) |> MapSet.new()
    frontier = open |> Enum.filter(&(status[&1] in ["active", "blocked"])) |> MapSet.new()

    keep =
      MapSet.union(in_edge, frontier)
      |> Enum.sort(:desc)
      |> Enum.take(@max_nodes)
      |> MapSet.new()

    nodes =
      keep
      |> Enum.map(fn id ->
        %{
          id: id,
          label: titled |> Map.get(id, %{}) |> Map.get("title", id) |> trunc_str(46),
          status: status[id],
          driver: driver_of(by_from, id)
        }
      end)

    kedges =
      dedges
      |> Enum.filter(&(MapSet.member?(keep, &1.from) and MapSet.member?(keep, &1.to)))
      |> Enum.map(&%{source: &1.from, target: &1.to, kind: &1.pred})

    %{nodes: nodes, edges: kedges}
  end

  defp fold(trips) do
    Enum.reduce(trips, {%{}, []}, fn [s, p, o], {nodes, edges} ->
      nodes = Map.put_new(nodes, s, %{})

      if ref_obj?(o) do
        {Map.put_new(nodes, o, %{}), [%{from: s, pred: p, to: o} | edges]}
      else
        {Map.update(nodes, s, %{p => o}, &Map.put(&1, p, o)), edges}
      end
    end)
  end

  defp ref_obj?(o), do: String.starts_with?(o, "@") and not String.contains?(o, " ")

  # board.js deriveCol; first match wins
  defp derive_status(attrs, out_edges, node_attrs) do
    cond do
      Map.has_key?(attrs, "abandoned") -> "abandoned"
      Map.has_key?(attrs, "outcome") -> "done"
      Enum.any?(out_edges, &(&1.pred == "driver")) -> "active"
      blocked?(out_edges, node_attrs) -> "blocked"
      Map.has_key?(attrs, "committed") -> "ready"
      true -> "backlog"
    end
  end

  defp blocked?(out_edges, node_attrs) do
    out_edges
    |> Enum.filter(&(&1.pred == "depends_on"))
    |> Enum.any?(fn e ->
      ta = Map.get(node_attrs, e.to)
      is_nil(ta) or (not Map.has_key?(ta, "outcome") and not Map.has_key?(ta, "abandoned"))
    end)
  end

  defp driver_of(by_from, id) do
    by_from
    |> Map.get(id, [])
    |> Enum.find_value(fn e -> if e.pred == "driver", do: String.replace_prefix(e.to, "@", "") end)
  end

  defp trunc_str(s, n) do
    if String.length(s) > n, do: String.slice(s, 0, n - 1) <> "…", else: s
  end
end

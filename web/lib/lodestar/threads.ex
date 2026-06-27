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

  # Kanban lane order; done/abandoned never reach here (scoped out by `open`).
  @lanes [{"active", "Active"}, {"blocked", "Blocked"}, {"ready", "Ready"}, {"backlog", "Backlog"}]

  @doc "%{nodes: [%{id,label,status,driver}], edges: [%{source,target,kind}]} — Cytoscape-ready."
  def graph(port \\ nil) do
    %{cards: cards, dedges: dedges, keep: keep} = scoped(port)

    kedges =
      dedges
      |> Enum.filter(&(MapSet.member?(keep, &1.from) and MapSet.member?(keep, &1.to)))
      |> Enum.map(&%{source: &1.from, target: &1.to, kind: &1.pred})

    %{nodes: cards, edges: kedges}
  end

  @doc "%{lanes: [%{key,label,cards: [%{id,label,status,driver}]}]} — same scoped threads, grouped by status."
  def board(port \\ nil) do
    %{cards: cards} = scoped(port)
    by_status = Enum.group_by(cards, & &1.status)

    lanes =
      for {key, label} <- @lanes do
        %{key: key, label: label, cards: Map.get(by_status, key, [])}
      end

    %{lanes: lanes}
  end

  # List view — ORTHOGONAL AXES, not a linear status (Tom's model). Every thread
  # carries an independent value on each axis, all DERIVED from claims:
  #   committed  — a `committed` claim: spec frozen / planning resolved / "execute next"
  #   scheduled  — a `do_on`: queued for a period (else unscheduled)
  #   active     — a live driver (an agent on it now)
  #   blocked    — an open depends_on
  # "backlog" was never a state — it was just committed+unscheduled. Removed.
  # The default DEFAULT lens groups by one urgency axis (no duplicate rows); each
  # row also ships its full facet set so the UI shows badges + can build compound
  # views (saved queries over the axes) without re-deriving.
  @list_lenses [
    {"active", "Active"},
    {"blocked", "Blocked"},
    {"scheduled", "Scheduled"},
    {"unscheduled", "Unscheduled"},
    {"draft", "Draft"}
  ]

  def list(port \\ nil) do
    port = port || Fram.board_port()
    {node_attrs, edges} = fold(Fram.all_triples(port))
    titled = for {id, attrs} <- node_attrs, Map.get(attrs, "title", "") != "", into: %{}, do: {id, attrs}
    by_from = Enum.group_by(edges, & &1.from)
    online = Lodestar.Presence.online_refs()

    rows =
      for {id, attrs} <- titled,
          status = derive_status(attrs, Map.get(by_from, id, []), node_attrs, online),
          status not in ["done", "abandoned"] do
        committed = Map.has_key?(attrs, "committed")
        scheduled = Map.get(attrs, "do_on", "") != ""
        active = status == "active"
        blocked = status == "blocked"

        %{
          id: id,
          title: Map.get(attrs, "title", id),
          do_on: Map.get(attrs, "do_on", ""),
          priority: Map.get(attrs, "priority", ""),
          driver: driver_of(by_from, id),
          # the orthogonal axes, explicit (the UI renders these as badges)
          committed: committed,
          scheduled: scheduled,
          active: active,
          blocked: blocked,
          lens: lens(active, blocked, committed, scheduled)
        }
      end

    by_lens = Enum.group_by(rows, & &1.lens)

    groups =
      for {key, label} <- @list_lenses do
        items = Map.get(by_lens, key, [])

        ordered =
          if key == "scheduled",
            # the execute queue: manual order (drag-set `priority`) wins, then do_on,
            # so the top row is literally "next". Unprioritized sort after by do_on.
            do: Enum.sort_by(items, &{prio_key(&1.priority), &1.do_on == "", &1.do_on}),
            else: Enum.sort_by(items, & &1.id, :desc)

        %{key: key, label: label, count: length(ordered), items: ordered}
      end

    %{groups: groups}
  end

  # Default mutually-exclusive lens (urgency order). Axes stay independent on the
  # row; this is only the grouping the default view collapses them to.
  defp lens(active, blocked, committed, scheduled) do
    cond do
      active -> "active"
      blocked -> "blocked"
      committed and scheduled -> "scheduled"
      committed -> "unscheduled"
      true -> "draft"
    end
  end

  # sort key for a drag-set priority claim: {0, n} for a parseable rank (ordered
  # ascending), {1, 0} for none (sorts after, falls back to do_on).
  defp prio_key(p) do
    case Float.parse(to_string(p)) do
      {f, _} -> {0, f}
      :error -> {1, 0.0}
    end
  end

  # Shared "compute scoped threads" core for graph/0 + board/0 — no logic drift.
  # Returns the scoped cards (graph nodes), the surviving dag edges, and the keep set.
  defp scoped(port) do
    port = port || Fram.board_port()
    {node_attrs, edges} = fold(Fram.all_triples(port))

    titled = for {id, attrs} <- node_attrs, Map.get(attrs, "title", "") != "", into: %{}, do: {id, attrs}
    by_from = Enum.group_by(edges, & &1.from)
    # "active" = driven by an agent live RIGHT NOW (driver edge → online agent),
    # not merely "has a driver claim". Cross-reference the agents daemon.
    online = Lodestar.Presence.online_refs()
    status = Map.new(titled, fn {id, attrs} -> {id, derive_status(attrs, Map.get(by_from, id, []), node_attrs, online)} end)

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

    cards =
      keep
      |> Enum.map(fn id ->
        %{
          id: id,
          label: titled |> Map.get(id, %{}) |> Map.get("title", id) |> trunc_str(46),
          status: status[id],
          driver: driver_of(by_from, id)
        }
      end)

    %{cards: cards, dedges: dedges, keep: keep}
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

  # board.js deriveCol, refined: "active" means a CURRENTLY-ONLINE agent is the
  # driver (not just any driver claim). first match wins.
  defp derive_status(attrs, out_edges, node_attrs, online) do
    cond do
      Map.has_key?(attrs, "abandoned") -> "abandoned"
      Map.has_key?(attrs, "outcome") -> "done"
      driven_live?(out_edges, online) -> "active"
      blocked?(out_edges, node_attrs) -> "blocked"
      Map.has_key?(attrs, "committed") -> "ready"
      true -> "backlog"
    end
  end

  # a driver edge pointing at an agent whose lease is live right now
  defp driven_live?(out_edges, online) do
    Enum.any?(out_edges, &(&1.pred == "driver" and MapSet.member?(online, &1.to)))
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

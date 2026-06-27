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

  @doc """
  Focused subgraph around `focus_id` — same JSON shape as graph/0 but filtered to
  the connected component reachable from the focus via depends_on/part_of edges in
  BOTH directions (ancestors + descendants), plus the edges among that node set.
  Bypasses the open/frontier/max_nodes scoping graph/0 applies: the point of focus
  is to show one thread's full local context, including done/abandoned neighbors.
  """
  def focused(focus_id, port \\ nil) do
    focus = if String.starts_with?(focus_id, "@"), do: focus_id, else: "@" <> focus_id
    port = port || Fram.board_port()
    {node_attrs, edges} = Lodestar.GraphCache.fold(port)

    titled = for {id, attrs} <- node_attrs, Map.get(attrs, "title", "") != "", into: %{}, do: {id, attrs}
    by_from = Enum.group_by(edges, & &1.from)
    online = Lodestar.Presence.online_refs()

    dedges =
      edges
      |> Enum.filter(&(&1.pred in @dag_preds))
      |> Enum.filter(&(Map.has_key?(titled, &1.from) and Map.has_key?(titled, &1.to)))

    keep = reachable(focus, dedges)

    nodes =
      keep
      |> Enum.filter(&Map.has_key?(titled, &1))
      |> Enum.map(fn id ->
        attrs = Map.get(titled, id, %{})

        %{
          id: id,
          label: attrs |> Map.get("title", id) |> trunc_str(46),
          status: derive_status(attrs, Map.get(by_from, id, []), node_attrs, online),
          driver: driver_of(by_from, id)
        }
      end)

    kedges =
      dedges
      |> Enum.filter(&(MapSet.member?(keep, &1.from) and MapSet.member?(keep, &1.to)))
      |> Enum.map(&%{source: &1.from, target: &1.to, kind: &1.pred})

    %{nodes: nodes, edges: kedges}
  end

  @doc """
  Resolve a ref — an `@id` OR an `@handle` — to a canonical thread id, off the
  cached board fold. An id and a handle are separate owners: the id is the opaque
  immutable key, the handle is an optional mutable alias.

  - `ref` is already a titled node → it IS an id; pass it through.
  - else treat `ref` minus its leading `@` as a handle, and return the id of the
    node whose `handle` attr matches. On duplicate handles, the latest `created_at`
    wins (ISO-8601 sorts chronologically).
  - no match → `ref` unchanged.

  This is the view/boundary concern: fram only ever sees the canonical id this
  returns, never a handle.
  """
  def resolve(ref) when is_binary(ref) do
    {node_attrs, _edges} = Lodestar.GraphCache.fold()

    cond do
      titled?(Map.get(node_attrs, ref)) ->
        ref

      true ->
        handle = String.replace_prefix(ref, "@", "")

        case Enum.filter(node_attrs, fn {_id, a} -> Map.get(a, "handle") == handle end) do
          [] -> ref
          matches -> matches |> Enum.max_by(fn {_id, a} -> Map.get(a, "created_at", "") end) |> elem(0)
        end
    end
  end

  defp titled?(%{} = attrs), do: Map.get(attrs, "title", "") != ""
  defp titled?(_), do: false

  # Undirected BFS over the dag edges from `start` — both edge directions are
  # walked so we collect ancestors AND descendants. Returns the connected node set.
  defp reachable(start, dedges) do
    adj =
      Enum.reduce(dedges, %{}, fn e, acc ->
        acc
        |> Map.update(e.from, [e.to], &[e.to | &1])
        |> Map.update(e.to, [e.from], &[e.from | &1])
      end)

    bfs([start], MapSet.new([start]), adj)
  end

  defp bfs([], seen, _adj), do: seen

  defp bfs([id | rest], seen, adj) do
    {seen, queue} =
      adj
      |> Map.get(id, [])
      |> Enum.reduce({seen, rest}, fn n, {seen, queue} ->
        if MapSet.member?(seen, n), do: {seen, queue}, else: {MapSet.put(seen, n), [n | queue]}
      end)

    bfs(queue, seen, adj)
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
  # Plan-primary lenses: the default view groups by the PLANNING axis. Scheduling
  # is NOT a group — it's a date badge + a sort (scheduled items float to the top
  # of Committed). "ready"/"unscheduled" retired (ambiguous). Active/blocked are
  # execution overlays; committed = plan resolved (the actionable pool); draft =
  # planning still open. Each row still carries all axes for badges/compound views.
  # Lanes = the thread's INTRINSIC resolution only (Draft → Open → Done). That's
  # the one axis the thread actually owns. ATTENTION ("active") is NOT a lane — it
  # is a relation the agent holds on the thread, so it renders as a live badge and
  # sorts active work to the top of Open (no stored "in progress" column to rot).
  # Blocked / scheduled / priority are overlays (badges + sort), never lanes.
  @list_lenses [
    {"open", "Open"},
    {"draft", "Draft"},
    {"done", "Done"}
  ]

  def list(port \\ nil) do
    port = port || Fram.board_port()
    {node_attrs, edges} = Lodestar.GraphCache.fold(port)
    titled = for {id, attrs} <- node_attrs, Map.get(attrs, "title", "") != "", into: %{}, do: {id, attrs}
    by_from = Enum.group_by(edges, & &1.from)
    online = Lodestar.Presence.online_refs()
    # children index for completion%: `child part_of parent` → group by parent.
    kids = edges |> Enum.filter(&(&1.pred == "part_of")) |> Enum.group_by(& &1.to, & &1.from)

    rows =
      for {id, attrs} <- titled,
          status = derive_status(attrs, Map.get(by_from, id, []), node_attrs, online) do
        closed = status in ["done", "abandoned"]
        committed = Map.has_key?(attrs, "committed")
        scheduled = Map.get(attrs, "do_on", "") != ""
        active = status == "active"
        blocked = status == "blocked"

        %{
          id: id,
          title: Map.get(attrs, "title", id),
          # mutable human alias (separate owner from the immutable id) + birth time
          handle: Map.get(attrs, "handle"),
          created_at: Map.get(attrs, "created_at", ""),
          do_on: Map.get(attrs, "do_on", ""),
          priority: Map.get(attrs, "priority", ""),
          driver: driver_of(by_from, id),
          # axes/overlays, explicit (the UI renders these as badges)
          committed: committed,
          scheduled: scheduled,
          active: active,
          blocked: blocked,
          # emergent-outcome completion: done children / total (nil if atomic)
          completion: completion(Map.get(kids, id, []), node_attrs),
          lens: lens(closed, committed)
        }
      end

    by_lens = Enum.group_by(rows, & &1.lens)

    groups =
      for {key, label} <- @list_lenses do
        items = Map.get(by_lens, key, [])

        ordered =
          if key == "open",
            # Open ordering: ATTENTION first (active now floats to top), then drag-set
            # priority, then scheduled (dated ahead of undated, by date). So "what's
            # being worked / what's next" surfaces without a lying status column.
            do: Enum.sort_by(items, &{bool_key(&1.active), prio_key(&1.priority), &1.do_on == "", &1.do_on}),
            else: Enum.sort_by(items, & &1.id, :desc)

        %{key: key, label: label, count: length(ordered), items: ordered}
      end

    %{groups: groups}
  end

  # Default mutually-exclusive lens (urgency order). Axes stay independent on the
  # row; this is only the grouping the default view collapses them to.
  # Intrinsic resolution lane. Done (work resolved) is the resting state; Open =
  # committed but not done; Draft = plan not yet committed. Attention is NOT here.
  defp lens(closed, committed) do
    cond do
      closed -> "done"
      committed -> "open"
      true -> "draft"
    end
  end

  defp bool_key(true), do: 0
  defp bool_key(_), do: 1

  # Emergent-outcome completion: %{done, total} over part_of children (a child is
  # "done" once it has an outcome). nil for atomic threads (no children).
  defp completion([], _node_attrs), do: nil

  defp completion(children, node_attrs) do
    done = Enum.count(children, &Map.has_key?(Map.get(node_attrs, &1, %{}), "outcome"))
    %{done: done, total: length(children)}
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
    {node_attrs, edges} = Lodestar.GraphCache.fold(port)

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

  @doc "Uncached fold of the full graph (all_triples → {node_attrs, edges}). The cache calls this."
  def fold_triples(port), do: fold(Fram.all_triples(port))

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

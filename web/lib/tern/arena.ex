defmodule Tern.Arena do
  @moduledoc """
  EXP-025 demo "arena" — the two-arm live task board (control vs graph).

  Given an `exp_id`, folds the board graph to DISCOVER the demo's task threads
  (each carries `exp_id` + `arm` + `task_id` + `title` — write-once attrs, so the
  cached fold reads them cleanly), then reads each task's DYNAMIC facets
  (`state` / `cost_usd` / `wall_s` / `updated`) FRESH per call via the daemon's
  `resolved` op.

  Why fresh (not from the fold): on the running board daemon those four preds
  ACCUMULATE (they are not in its single-valued set), so a tell appends rather
  than supersedes. `all_triples` returns them newest-first, which the generic
  fold's last-wins would collapse to the OLDEST value — wrong for a live board.
  `resolved`'s `:values` is insertion-ordered (oldest→newest), so `List.last`
  is the current value. Reading fresh each request also removes the ~cache-lag,
  keeping the board within the demo's ≤2s liveness target.

  Shape (JSON):
      %{exp: id, start_ts: earliest_updated_iso, columns: %{
        "control" => %{arm, tasks: [row...], totals: %{green,total,cost_usd,elapsed_s}},
        "graph"   => %{...}}}
  where row = %{id, task_id, title, arm, state, cost_usd, wall_s, updated}.
  """
  alias Tern.{Fram, GraphCache}

  # Fixed column order: control left, graph right.
  @arms ~w(control graph)

  @doc "Arena payload for one experiment id."
  def view(exp_id, port \\ nil) do
    port = port || Fram.board_port()
    {node_attrs, _edges} = GraphCache.fold(port)

    discovered =
      for {id, attrs} <- node_attrs,
          Map.get(attrs, "exp_id") == exp_id,
          Map.get(attrs, "arm") in @arms,
          do: {id, attrs}

    tasks =
      discovered
      |> Task.async_stream(fn {id, attrs} -> task_row(port, id, attrs) end,
        timeout: 6_000,
        on_timeout: :kill_task,
        ordered: false
      )
      |> Enum.flat_map(fn
        {:ok, row} -> [row]
        _ -> []
      end)

    by_arm = Enum.group_by(tasks, & &1.arm)

    columns =
      Map.new(@arms, fn arm ->
        col = by_arm |> Map.get(arm, []) |> Enum.sort_by(& &1.task_id)
        {arm, %{arm: arm, tasks: col, totals: totals(col)}}
      end)

    start_ts =
      tasks
      |> Enum.map(& &1.updated)
      |> Enum.reject(&(&1 == ""))
      |> min_or_empty()

    %{exp: exp_id, start_ts: start_ts, columns: columns}
  end

  # One task tile: static attrs from the fold, dynamic facets fresh from the daemon.
  defp task_row(port, id, attrs) do
    %{
      id: id,
      task_id: Map.get(attrs, "task_id", id),
      title: Map.get(attrs, "title", ""),
      arm: Map.get(attrs, "arm"),
      state: Fram.latest(port, id, "state") || "pending",
      cost_usd: Fram.latest(port, id, "cost_usd") || "0",
      wall_s: Fram.latest(port, id, "wall_s") || "0",
      updated: Fram.latest(port, id, "updated") || ""
    }
  end

  # Per-column running totals: green tiles, sum $, and the arm's own wall time
  # (max wall_s across its tasks).
  defp totals(tasks) do
    %{
      green: Enum.count(tasks, &(&1.state == "green")),
      total: length(tasks),
      cost_usd: Enum.reduce(tasks, 0.0, fn t, a -> a + parse_float(t.cost_usd) end) |> Float.round(2),
      elapsed_s: tasks |> Enum.map(&parse_int(&1.wall_s)) |> max_or_zero()
    }
  end

  defp min_or_empty([]), do: ""
  defp min_or_empty(l), do: Enum.min(l)
  defp max_or_zero([]), do: 0
  defp max_or_zero(l), do: Enum.max(l)

  defp parse_float(v) do
    case Float.parse(to_string(v)) do
      {f, _} -> f
      :error -> 0.0
    end
  end

  defp parse_int(v) do
    case Integer.parse(to_string(v)) do
      {n, _} -> n
      :error -> 0
    end
  end
end

defmodule Tern.Presence do
  @moduledoc """
  Live agent roster for the right panel. Ports the presence aggregation from the
  archived v1 bridge.clj: per-handle row built from @agent:<h>, @session:<h>,
  and the @lease:session:<h> liveness lease, then sorted online-first.

  Server-side (drives Tern.Fram over TCP).
  """

  alias Tern.Fram

  @doc """
  Roster of agent maps for rendering:
  %{uuid, online, expires_s, roles, model, effort, lifecycle,
    current_thread, active_workflow, task, cost, focus}
  Sorted: online first, then with-focus, then by handle.
  """
  def roster(port \\ nil) do
    port = port || Fram.agents_port()
    now = System.system_time(:millisecond)
    tokens = Fram.agent_tokens(port)

    port
    |> Fram.agents()
    |> Enum.map(fn [_session_entity, h] -> build_row(port, h, now, tokens) end)
    |> Enum.sort_by(fn r -> {if(r.online, do: 0, else: 1), if(r.focus, do: 0, else: 1), r.uuid} end)
  end

  @doc """
  Set of agent ENTITY refs (\"@agent:<h>\") whose lease is currently live.
  Cheap (one lease resolve per handle) — used to decide whether a thread's
  driver is an agent working RIGHT NOW (the real meaning of \"active\").
  """
  def online_refs(port \\ nil) do
    port = port || Fram.agents_port()
    now = System.system_time(:millisecond)

    port
    |> Fram.agents()
    |> Enum.filter(fn [_e, h] -> elem(lease_state(port, h, now), 0) end)
    |> Enum.map(fn [_e, h] -> "@agent:" <> h end)
    |> MapSet.new()
  end

  defp build_row(port, h, now, tokens) do
    {online, expires_s} = lease_state(port, h, now)

    current_thread = Fram.resolved(port, "@session:#{h}", "current_thread")
    active_workflow = Fram.resolved(port, "@session:#{h}", "active_workflow")
    task = Fram.resolved(port, "@session:#{h}", "task")
    roles = roles(port, h)
    model = Fram.resolved(port, "@agent:#{h}", "model")
    tok = Map.get(tokens, h, %{context: 0, total: 0})
    focus = !is_nil(active_workflow) or !is_nil(current_thread) or !is_nil(task)
    spawned_at = Fram.resolved(port, "@agent:#{h}", "spawned_at")
    elapsed_str = elapsed_str(spawned_at, now)

    %{
      uuid: h,
      online: online,
      expires_s: expires_s,
      roles: roles,
      model: model,
      effort: Fram.resolved(port, "@agent:#{h}", "effort"),
      lifecycle: Fram.resolved(port, "@agent:#{h}", "lifecycle"),
      current_thread: current_thread,
      active_workflow: active_workflow,
      task: task,
      context_tokens: tok.context,
      total_tokens: tok.total,
      focus: focus,
      # "thinking" = live AND working on something; elapsed measured from spawn.
      spawned_at: spawned_at,
      thinking: online and focus,
      elapsed_str: elapsed_str,
      # display strings precomputed server-side (keep template client-stdlib-free)
      roles_str: Enum.join(roles, ", "),
      model_str: model || "",
      ctx_str: fmt_tokens(tok.context),
      total_str: fmt_tokens(tok.total),
      focus_str: active_workflow || current_thread || task || ""
    }
  end

  # spawned_at is ISO-8601 with nanoseconds; "" when nil/unparseable.
  defp elapsed_str(spawned_at, now) when is_binary(spawned_at) do
    with {:ok, dt, _offset} <- DateTime.from_iso8601(spawned_at) do
      now_s = div(now, 1000)
      fmt_duration(now_s - DateTime.to_unix(dt))
    else
      _ -> ""
    end
  end

  defp elapsed_str(_spawned_at, _now), do: ""

  # whole-second elapsed -> "Xh Ym" / "Xm Ys" / "Xs"
  defp fmt_duration(s) when s >= 3600, do: "#{div(s, 3600)}h #{div(rem(s, 3600), 60)}m"
  defp fmt_duration(s) when s >= 60, do: "#{div(s, 60)}m #{rem(s, 60)}s"
  defp fmt_duration(s), do: "#{max(s, 0)}s"

  @doc "Fleet token totals for the status line: %{context, total} as display strings."
  def fleet_tokens(roster) do
    ctx = Enum.reduce(roster, 0, &(&1.context_tokens + &2))
    tot = Enum.reduce(roster, 0, &(&1.total_tokens + &2))
    %{context: fmt_tokens(ctx), total: fmt_tokens(tot)}
  end

  def fmt_tokens(n) when n >= 1_000_000, do: "#{Float.round(n / 1_000_000, 2)}M"
  def fmt_tokens(n) when n >= 1_000, do: "#{div(n, 1000)}k"
  def fmt_tokens(n), do: "#{n}"

  # lease format: "holder|exp_ms|epoch"; online iff a parseable exp is in the future.
  defp lease_state(port, h, now) do
    with raw when is_binary(raw) <- Fram.resolved(port, "@lease:session:#{h}", "lease"),
         [_holder, exp_str | _] <- String.split(raw, "|"),
         {exp, _} <- Integer.parse(exp_str),
         true <- exp > now do
      {true, div(exp - now, 1000)}
    else
      _ -> {false, nil}
    end
  end

  defp roles(port, h) do
    port
    |> Fram.resolved_many("@agent:#{h}", "holds")
    |> Enum.filter(&String.starts_with?(&1, "@role:"))
    |> Enum.map(&String.replace_prefix(&1, "@role:", ""))
    |> Enum.sort()
  end
end

defmodule Lodestar.Fram do
  @moduledoc """
  Server-side client for the fram claim-graph daemons (TCP, line-delimited EDN).

  Wire protocol (one request per connection): write one EDN op line + "\\n",
  read one EDN line back, decode. Mirrors the archived Clojure bridge's rt.clj.
  Server-only — uses :gen_tcp, never compiled to the client.

  Daemons: agents :7978, board/threads :7977, attention :7980.

  EDN decode note: `eden` maps EDN keywords -> atoms, but EDN vectors ->
  %Array{} structs (elixir_array backend), recursively. `query/2` normalizes
  those back to plain Elixir lists so callers pattern-match normally.
  """

  @host ~c"127.0.0.1"
  @agents_port 7978
  @board_port 7977
  @timeout 8_000
  # line-framed reads: the daemon returns one (possibly large) EDN line; size the
  # socket buffer generously so a full-graph response isn't truncated.
  @recbuf 16_000_000

  def agents_port, do: @agents_port
  def board_port, do: @board_port

  @doc "Send one EDN op string to a daemon; return the decoded+normalized response (or nil on failure)."
  def query(port, edn_op) do
    opts = [:binary, active: false, packet: :line, recbuf: @recbuf, buffer: @recbuf]

    with {:ok, sock} <- :gen_tcp.connect(@host, port, opts, @timeout),
         :ok <- :gen_tcp.send(sock, edn_op <> "\n"),
         {:ok, line} <- :gen_tcp.recv(sock, 0, @timeout) do
      :gen_tcp.close(sock)
      line |> Eden.decode!() |> normalize()
    else
      _ -> nil
    end
  rescue
    _ -> nil
  end

  # eden returns EDN vectors as %Array{}; convert recursively to plain lists.
  # Maps recurse into values; everything else (atoms, strings, numbers) passes through.
  defp normalize(%Array{} = a), do: a |> Array.to_list() |> Enum.map(&normalize/1)
  defp normalize(%{} = m) when not is_struct(m), do: Map.new(m, fn {k, v} -> {k, normalize(v)} end)
  defp normalize(other), do: other

  # ---- EDN op builders --------------------------------------------------------

  @roster_op ~S<{:op :query :query {:find "s" :rules [{:head {:rel "s" :args [{:var "e"} {:var "h"}]} :body [{:rel "triple" :args [{:var "e"} "agent" {:var "h"}]}]}]}}>

  @costs_op ~S<{:op :query :query {:find "r" :rules [{:head {:rel "r" :args [{:var "run"} {:var "a"} {:var "c"}]} :body [{:rel "triple" :args [{:var "run"} "agent" {:var "a"}]} {:rel "triple" :args [{:var "run"} "cost_usd" {:var "c"}]}]}]}}>

  @all_triples_op ~S<{:op :query :query {:find "t" :rules [{:head {:rel "t" :args [{:var "s"} {:var "p"} {:var "o"}]} :body [{:rel "triple" :args [{:var "s"} {:var "p"} {:var "o"}]}]}]}}>

  defp resolved_op(te, pred), do: ~s<{:op :resolved :te "#{te}" :p "#{pred}"}>

  # ---- accessors (mirror rt.clj) ---------------------------------------------

  @doc "[[session_entity, handle], ...] — one row per live handle (@session:* scoped, deduped)."
  def agents(port \\ @agents_port) do
    case query(port, @roster_op) do
      %{ok: rows} when is_list(rows) ->
        rows
        |> Enum.filter(fn [e, _h] -> String.starts_with?(e, "@session:") end)
        |> Enum.reduce(%{}, fn [e, h], acc -> Map.put(acc, h, [e, h]) end)
        |> Map.values()

      _ ->
        []
    end
  end

  @doc "%{handle => summed cost_usd}, across all @run:* records."
  def agent_costs(port \\ @agents_port) do
    case query(port, @costs_op) do
      %{ok: rows} when is_list(rows) ->
        Enum.reduce(rows, %{}, fn [_run, a, c], acc ->
          Map.update(acc, a, parse_float(c), &(&1 + parse_float(c)))
        end)

      _ ->
        %{}
    end
  end

  @doc "Single resolved value for entity+predicate, or nil."
  def resolved(port, te, pred) do
    case query(port, resolved_op(te, pred)) do
      %{value: v} when not is_nil(v) -> to_string(v)
      _ -> nil
    end
  end

  @doc "All resolved values for entity+predicate, as a list of strings."
  def resolved_many(port, te, pred) do
    case query(port, resolved_op(te, pred)) do
      %{values: vs} when is_list(vs) -> Enum.map(vs, &to_string/1)
      _ -> []
    end
  end

  @doc "Every [s, p, o] triple in a daemon's graph."
  def all_triples(port) do
    case query(port, @all_triples_op) do
      %{ok: rows} when is_list(rows) -> Enum.map(rows, fn [s, p, o] -> [to_string(s), to_string(p), to_string(o)] end)
      _ -> []
    end
  end

  @token_preds ~w(input_tokens output_tokens cache_create_tokens cache_read_tokens)

  @doc """
  Per-handle token usage folded from @run:* records:
  %{handle => %{context: latest_run_input_tokens, total: sum_all_token_types}}.
  `context` = the live window fill (most recent run by ended_at); `total` = all-time.
  """
  def agent_tokens(port \\ @agents_port) do
    runs =
      port
      |> all_triples()
      |> Enum.reduce(%{}, fn [s, p, o], acc ->
        if String.starts_with?(s, "@run:") and (p == "agent" or p == "ended_at" or p in @token_preds) do
          Map.update(acc, s, %{p => o}, &Map.put(&1, p, o))
        else
          acc
        end
      end)

    runs
    |> Map.values()
    |> Enum.filter(&Map.has_key?(&1, "agent"))
    |> Enum.group_by(&Map.get(&1, "agent"))
    |> Map.new(fn {handle, rs} ->
      total =
        Enum.reduce(rs, 0, fn r, sum ->
          sum + Enum.reduce(@token_preds, 0, fn tp, s2 -> s2 + parse_int(Map.get(r, tp, "0")) end)
        end)

      latest = Enum.max_by(rs, &Map.get(&1, "ended_at", ""), fn -> %{} end)
      {handle, %{context: parse_int(Map.get(latest, "input_tokens", "0")), total: total}}
    end)
  end

  defp parse_int(v) do
    case Integer.parse(to_string(v)) do
      {n, _} -> n
      :error -> 0
    end
  end

  defp parse_float(c) do
    case Float.parse(to_string(c)) do
      {f, _} -> f
      :error -> 0.0
    end
  end
end

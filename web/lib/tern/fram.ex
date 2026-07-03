defmodule Tern.Fram do
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
  # presence + @run telemetry moved to the canonical :7977 board (port-partition fix); :7978 retired
  @agents_port 7977
  @board_port 7977
  @timeout 8_000
  # line-framed reads: the daemon returns one (possibly large) EDN line; size the
  # socket buffer generously so a full-graph response isn't truncated.
  @recbuf 16_000_000

  def agents_port, do: @agents_port
  def board_port, do: @board_port

  @ports %{"agents" => @agents_port, "board" => @board_port, "code" => 7979, "attention" => 7980}
  @doc "Map a graph name to its daemon port (default: board)."
  def port_for(graph), do: Map.get(@ports, graph, @board_port)

  # ---- writes (OCC: read version → assert/retract with :base → retry) --------

  @doc "Current head version of a daemon, or nil."
  def version(port) do
    case query(port, "{:op :version}") do
      %{version: v} when is_integer(v) -> v
      _ -> nil
    end
  end

  @doc "Assert a claim (te p r). Single-valued preds supersede; multi add. {:ok v} | {:conflict r} | {:error _}."
  def assert!(port, te, p, r), do: occ(port, "assert", te, p, r, 5)

  @doc "Retract the exact claim (te p r). {:ok v} | {:conflict r} | {:error _}."
  def retract!(port, te, p, r), do: occ(port, "retract", te, p, r, 5)

  defp occ(_port, _op, _te, _p, _r, 0), do: {:conflict, :tries_exhausted}

  defp occ(port, op, te, p, r, tries) do
    case version(port) do
      nil ->
        {:error, :nodaemon}

      v ->
        edn = ~s({:op :#{op} :te "#{esc(te)}" :p "#{esc(p)}" :r "#{esc(r)}" :base #{v}})

        case query(port, edn) do
          %{ok: nv} -> {:ok, nv}
          %{version: nv} -> {:ok, nv}
          resp when is_map(resp) -> if rejected?(resp), do: occ(port, op, te, p, r, tries - 1), else: {:ok, resp}
          _ -> {:error, :no_response}
        end
    end
  end

  defp rejected?(m), do: Map.has_key?(m, :reject) or Map.has_key?(m, :conflict)
  defp esc(s), do: s |> to_string() |> String.replace("\\", "\\\\") |> String.replace("\"", "\\\"")

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

  @doc """
  Like `query/2`, but asks the daemon to reply in JSON (`:fmt :json`) and decodes
  with Jason instead of eden — Jason is dramatically faster on the large reads.

  The op is a hand-built EDN string; ` :fmt :json` is spliced in before the op
  map's closing brace. A new daemon honors `:fmt` and returns
  `{"ok":[["s","p","o"],...]}`; we decode that with `Jason.decode!(keys: :atoms)`
  so the result matches `query/2`'s shape (atom keys, plain lists — no %Array{}).

  Fallback: an older daemon ignores the unknown `:fmt` key and still returns EDN.
  EDN keyword keys (`:ok`) aren't valid JSON, so `Jason.decode!` raises; we then
  decode the same line through the eden path. One call therefore works against
  BOTH old and new daemons.
  """
  def json_query(port, edn_op) do
    json_op = String.replace_suffix(edn_op, "}", " :fmt :json}")
    opts = [:binary, active: false, packet: :line, recbuf: @recbuf, buffer: @recbuf]

    with {:ok, sock} <- :gen_tcp.connect(@host, port, opts, @timeout),
         :ok <- :gen_tcp.send(sock, json_op <> "\n"),
         {:ok, line} <- :gen_tcp.recv(sock, 0, @timeout) do
      :gen_tcp.close(sock)
      decode_json_or_edn(line)
    else
      _ -> nil
    end
  rescue
    _ -> nil
  end

  # New daemon → JSON (fast, string keys → atomized to match query/2). Old daemon
  # ignored :fmt → EDN → Jason raises → fall back to eden + normalize.
  defp decode_json_or_edn(line) do
    Jason.decode!(line, keys: :atoms)
  rescue
    _ -> line |> Eden.decode!() |> normalize()
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

  @doc """
  Latest resolved value for entity+predicate. `resolved`'s `:values` is
  insertion-ordered (oldest→newest), so for a pred that ACCUMULATES (not in the
  daemon's single-valued set) the last element is the current value; a genuinely
  single-valued pred falls back to `:value`. nil if absent.
  """
  def latest(port, te, pred) do
    case query(port, resolved_op(te, pred)) do
      %{values: vs} when is_list(vs) and vs != [] -> vs |> List.last() |> to_string()
      %{value: v} when not is_nil(v) -> to_string(v)
      _ -> nil
    end
  end

  @doc """
  Every [s, p, o] triple in a daemon's graph. This is the 1.67MB hot read, so it
  takes the JSON path (`json_query/2` → Jason) and transparently falls back to the
  EDN decoder against older daemons that ignore `:fmt`.
  """
  def all_triples(port) do
    case json_query(port, @all_triples_op) do
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

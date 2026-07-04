defmodule Tern.Stream do
  @moduledoc """
  Reads an agent's activity stream into chat messages for the right panel.
  Two sources, tried in order:

    1. The SDK stream-writer file `~/code/agent-data/agent-<handle>.stream.jsonl`
       (sdk-* agents). One JSON event per line:
         {"type":"assistant","content":[{"type":"text",..} | {"type":"tool_use","name":..}]}
         {"type":"result","result":".."}
         {"type":"system",...}                     (hook/init noise — skipped)

    2. FALLBACK for interactive Claude Code sessions (handles `cc-<repo>-<8hex>`),
       which have no stream file: the raw transcript under
       `~/.claude/projects/<flattened-cwd>/<session-uuid>.jsonl`, resolved by
       globbing on the 8-hex session-uuid prefix (most-recently-modified wins).
       Different, richer line format — see `transcript_line/1`.

  Messages are `%{kind: "user"|"text"|"tool"|"result", text: ..}` — the JS
  renderer styles per-kind.

  PERFORMANCE: transcripts can exceed 100MB and the pane polls. We never read
  the whole file — we seek to EOF minus ~512KB, drop the leading partial line,
  and parse only that tail. The last #{200} messages are returned regardless.
  """

  @dir Path.join(System.get_env("HOME") || "", "code/agent-data")
  @projects Path.join(System.get_env("HOME") || "", ".claude/projects")
  @max 200
  @tail_bytes 512 * 1024

  @doc ~S(Chat messages for an agent handle: [%{kind, text}].)
  def messages(handle) do
    path = Path.join(@dir, "agent-#{handle}.stream.jsonl")

    case File.read(path) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Enum.flat_map(&parse_line/1)
        |> Enum.take(-@max)

      _ ->
        transcript_messages(handle)
    end
  end

  # --- SDK stream format -----------------------------------------------------

  defp parse_line(line) do
    case Jason.decode(line) do
      {:ok, %{"type" => "assistant", "content" => content}} when is_list(content) ->
        Enum.flat_map(content, &block/1)

      {:ok, %{"type" => "result", "result" => r}} when is_binary(r) and r != "" ->
        [%{kind: "result", text: r}]

      _ ->
        []
    end
  end

  defp block(%{"type" => "text", "text" => t}) when is_binary(t) and t != "", do: [%{kind: "text", text: t}]
  defp block(%{"type" => "tool_use", "name" => n}) when is_binary(n), do: [%{kind: "tool", text: n}]
  defp block(_), do: []

  # --- Claude Code transcript fallback ---------------------------------------

  defp transcript_messages(handle) do
    with hex when is_binary(hex) <- session_hex(handle),
         path when is_binary(path) <- resolve_transcript(hex) do
      path
      |> tail_lines()
      |> Enum.flat_map(&transcript_line/1)
      |> Enum.take(-@max)
    else
      _ -> []
    end
  end

  # cc-<repo>-<8hex> -> the 8-hex session-uuid prefix; nil for other handles.
  defp session_hex(handle) do
    case Regex.run(~r/^cc-.+-([0-9a-f]{8})$/, handle) do
      [_, hex] -> hex
      _ -> nil
    end
  end

  # Most-recently-modified transcript whose uuid starts with `hex`; nil if none.
  defp resolve_transcript(hex) do
    Path.join(@projects, "*/#{hex}*.jsonl")
    |> Path.wildcard()
    |> case do
      [] ->
        nil

      paths ->
        paths
        |> Enum.max_by(fn p ->
          case File.stat(p, time: :posix) do
            {:ok, %{mtime: m}} -> m
            _ -> 0
          end
        end)
    end
  end

  # Read only the trailing ~512KB, dropping the leading partial line.
  defp tail_lines(path) do
    case File.open(path, [:read, :binary]) do
      {:ok, io} ->
        {:ok, size} = :file.position(io, :eof)
        start = max(size - @tail_bytes, 0)

        lines =
          case :file.pread(io, start, size - start) do
            {:ok, data} ->
              parts = :binary.split(data, "\n", [:global])
              # start > 0 means we sliced mid-line — the first fragment is partial.
              if start > 0, do: tl(parts), else: parts

            _ ->
              []
          end

        :file.close(io)
        Enum.reject(lines, &(&1 == ""))

      _ ->
        []
    end
  end

  # Map one transcript line to zero or more chat messages. Skips sidechains,
  # system/summary noise, thinking blocks, tool_result turns, and command/meta
  # user lines — only genuine assistant output and human turns survive.
  defp transcript_line(line) do
    case Jason.decode(line) do
      {:ok, %{"isSidechain" => true}} ->
        []

      {:ok, %{"type" => "assistant", "message" => %{"content" => content}}} when is_list(content) ->
        Enum.flat_map(content, &transcript_block/1)

      {:ok, %{"type" => "user", "isMeta" => true}} ->
        []

      {:ok, %{"type" => "user", "message" => %{"content" => content}}} ->
        user_turn(content)

      _ ->
        []
    end
  end

  # assistant content blocks: text -> text, tool_use -> tool; thinking dropped.
  defp transcript_block(%{"type" => "text", "text" => t}) when is_binary(t) and t != "",
    do: [%{kind: "text", text: t}]

  defp transcript_block(%{"type" => "tool_use", "name" => n}) when is_binary(n),
    do: [%{kind: "tool", text: n}]

  defp transcript_block(_), do: []

  # A user turn is a genuine human message. Reject tool_result arrays (tool
  # output, not a human turn) and command/system-echo wrappers (<command-name>,
  # <local-command-stdout>, <bash-input>, …).
  defp user_turn(content) when is_binary(content) do
    trimmed = String.trim_leading(content)

    if trimmed == "" or String.starts_with?(trimmed, "<") do
      []
    else
      [%{kind: "user", text: content}]
    end
  end

  defp user_turn(content) when is_list(content) do
    cond do
      Enum.any?(content, &(is_map(&1) and &1["type"] == "tool_result")) ->
        []

      true ->
        text =
          content
          |> Enum.filter(&(is_map(&1) and &1["type"] == "text" and is_binary(&1["text"])))
          |> Enum.map_join("\n", & &1["text"])
          |> String.trim()

        if text == "", do: [], else: [%{kind: "user", text: text}]
    end
  end

  defp user_turn(_), do: []
end

defmodule Tern.Stream do
  @moduledoc """
  Reads an agent's activity stream (.stream.jsonl written by the SDK
  stream-writer) into chat messages for the right panel. Server-side.

  Line format (one JSON event per line):
    {"type":"assistant","content":[{"type":"text","text":..} | {"type":"tool_use","name":..}]}
    {"type":"result","result":".."}
    {"type":"system",...}                      (hook/init noise — skipped)
  """

  @dir Path.join(System.get_env("HOME") || "", "code/agent-data")
  @max 200

  @doc "Chat messages for an agent handle: [%{kind: \"text\"|\"tool\"|\"result\", text}]."
  def messages(handle) do
    path = Path.join(@dir, "agent-#{handle}.stream.jsonl")

    case File.read(path) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Enum.flat_map(&parse_line/1)
        |> Enum.take(-@max)

      _ ->
        []
    end
  end

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
end

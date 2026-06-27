defmodule Lodestar.Id do
  @moduledoc """
  Thread identity minting. An id is a UUIDv7: a 48-bit unix-ms timestamp in the
  high bits (so lexicographic order ~ chronological), then version 7, the RFC 9562
  variant, and random fill. Pure Elixir — no dependency.

  The id carries ONLY identity — it is an opaque, immutable, collision-proof key.
  App ordering/display reads the explicit `created_at` claim, never these internal
  timestamp bits. Old `@YYYY-MM-DD-HHMMSS` ids stay valid (ids are opaque to fram);
  this only governs how fresh ids are minted.
  """

  @doc "A fresh canonical lowercase UUIDv7 string, 8-4-4-4-12 hex."
  def uuid7 do
    ts = System.system_time(:millisecond)
    # 74 random bits: 12 for rand_a (after the version nibble), 62 for rand_b
    # (after the 2-bit variant). strong_rand_bytes(10) = 80 bits; drop the tail 6.
    <<rand_a::12, rand_b::62, _::6>> = :crypto.strong_rand_bytes(10)

    <<ts::big-unsigned-48, 7::4, rand_a::12, 2::2, rand_b::62>>
    |> format()
  end

  # 16 bytes -> 4-2-2-2-6 byte groups -> 8-4-4-4-12 lowercase hex.
  defp format(<<a::binary-size(4), b::binary-size(2), c::binary-size(2), d::binary-size(2), e::binary-size(6)>>) do
    Enum.map_join([a, b, c, d, e], "-", &Base.encode16(&1, case: :lower))
  end
end

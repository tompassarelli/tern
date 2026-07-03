import { describe, test, expect } from "bun:test";
import { encode, decode, tryDecode, isRecord } from "./index.js";
import { crush, strip, isSentinel, hashOf, DEFAULTS } from "./ccr.js";

// ── ESO round-trip ───────────────────────────────────────────────────────────

describe("ESO encode/decode round-trip", () => {
  test("record array — basic", () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      path: `src/file${i}.ts`,
      line: i + 1,
    }));
    const doc = { findings: records };
    const rt = decode(encode(doc));
    expect(rt.findings).toEqual(records);
  });

  test("empty array", () => {
    const doc = { items: [] };
    const rt = decode(encode(doc));
    expect(rt.items).toEqual([]);
  });

  test("unicode values in cells", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      msg: `héllo wörld ${i} — 日本語`,
      n: i,
    }));
    const doc = { rows: records };
    const rt = decode(encode(doc));
    expect(rt.rows).toEqual(records);
  });

  test("tabs and newlines in string values use JSON quoting", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      text: `line\tone\ntwo\t${i}`,
      idx: i,
    }));
    const doc = { data: records };
    const rt = decode(encode(doc));
    expect(rt.data).toEqual(records);
  });

  test("null and boolean values", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      ok: i % 2 === 0,
      val: i % 3 === 0 ? null : i,
    }));
    const doc = { rows: records };
    const rt = decode(encode(doc));
    expect(rt.rows).toEqual(records);
  });

  test("scalar fields survive round-trip", () => {
    const doc = {
      from: "agent-a",
      to: "agent-b",
      count: 42,
      done: true,
      nothing: null,
      items: [{ x: "1" }, { x: "2" }, { x: "3" }, { x: "4" }, { x: "5" },
               { x: "6" }, { x: "7" }, { x: "8" }, { x: "9" }, { x: "10" }],
    };
    const rt = decode(encode(doc));
    expect(rt.from).toBe("agent-a");
    expect(rt.to).toBe("agent-b");
    expect(rt.count).toBe(42);
    expect(rt.done).toBe(true);
    expect(rt.nothing).toBe(null);
    expect(rt.items).toEqual(doc.items);
  });

  test("count is a checksum — truncated rows fail", () => {
    // Manually craft a document with wrong count
    const bad = "!eso/1\nrows[5]{a,b}\nv1\tv2\n";
    const result = tryDecode(bad);
    expect(result.ok).toBe(false);
  });

  test("tryDecode returns ok:false on invalid input", () => {
    const result = tryDecode("not eso at all");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("tryDecode returns ok:true on valid input", () => {
    const encoded = encode({ x: "hello" });
    const result = tryDecode(encoded);
    expect(result.ok).toBe(true);
    expect((result as any).value.x).toBe("hello");
  });

  test("isRecord utility", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("str")).toBe(false);
  });
});

// ── CCR crush/retrieve fidelity ──────────────────────────────────────────────

describe("CCR crush/strip", () => {
  test("passthrough below minItems", () => {
    const arr = [{ a: "1" }, { a: "2" }, { a: "3" }];
    const { view, hash, dropped } = crush(arr);
    expect(view).toBe(arr); // same reference
    expect(hash).toBe(null);
    expect(dropped).toBe(0);
  });

  test("crush large array: dropped > 0, sentinel present", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ id: i, val: `v${i}` }));
    const { view, hash, dropped } = crush(arr);
    expect(dropped).toBeGreaterThan(0);
    expect(hash).not.toBe(null);
    expect(view.length).toBeLessThan(arr.length);
    // sentinel is last element
    const sentinel = view[view.length - 1];
    expect(isSentinel(sentinel)).toBe(true);
  });

  test("strip removes sentinel", () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const { view } = crush(arr);
    const stripped = strip(view);
    expect(stripped.every((x: any) => !isSentinel(x))).toBe(true);
    expect(stripped.length).toBeGreaterThan(0);
  });

  test("hash is deterministic", () => {
    const arr = [{ x: "a" }, { x: "b" }, { x: "c" }];
    expect(hashOf(arr)).toBe(hashOf(arr));
    expect(hashOf(arr)).not.toBe(hashOf([{ x: "b" }]));
  });

  test("crush keeps first and last element", () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ n: i }));
    const { view } = crush(arr);
    const stripped = strip(view);
    const ids = stripped.map((r: any) => r.n);
    expect(ids).toContain(0);   // first
    expect(ids).toContain(29);  // last
  });

  test("crush preserves change-points (level transitions)", () => {
    // 20 info rows, then 5 warn rows, then 5 info rows
    const arr = [
      ...Array.from({ length: 20 }, (_, i) => ({ level: "info", n: i })),
      ...Array.from({ length: 5 },  (_, i) => ({ level: "warn", n: 20 + i })),
      ...Array.from({ length: 5 },  (_, i) => ({ level: "info", n: 25 + i })),
    ];
    const { view } = crush(arr, { maxItems: 15 });
    const stripped = strip(view);
    const levels = stripped.map((r: any) => r.level);
    // Must include at least one warn
    expect(levels).toContain("warn");
  });

  test("isSentinel rejects non-sentinel objects", () => {
    expect(isSentinel({ _ccr: "random string" })).toBe(false);
    expect(isSentinel({ other: "field" })).toBe(false);
    expect(isSentinel(null)).toBe(false);
    expect(isSentinel("string")).toBe(false);
  });
});

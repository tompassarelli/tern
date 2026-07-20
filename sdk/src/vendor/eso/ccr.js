// Vendored from https://github.com/Green-PT/honey-for-devs eso/ (MIT) — see LICENSE-NOTICE.md. Converted require/module.exports → ESM import/export for bun compatibility.
"use strict";

// CCR — Compress-Cache-Retrieve for high-volume, redundant array tool output.
// Lossy-but-recoverable: keep an informative sample of an array's items, drop
// the rest, leave a sentinel naming a hash the originals are cached under. The
// agent retrieves the full array by hash when it needs a dropped row. A lossy
// view is never emitted unless the cache has already returned an exact snapshot.
//
// Pure module — no fs. The file cache lives in bin/eso.js (crush/retrieve),
// matching eso/index.js's no-side-effects rule. Selection keeps head and tail
// fractions plus change-points, subject to an item cap.

import crypto from "node:crypto";
import { isRecord } from "./index.js";

const SENTINEL_KEY = "_ccr";
const SENTINEL_RE = /^<<ccr:[0-9a-f]{16} \d+_rows_offloaded>>$/;
const DEFAULTS = { minItems: 5, maxItems: 15, firstFraction: 0.3, lastFraction: 0.15 };

// Match the marker shape, not just the key — real data carrying a `_ccr` string
// must not be mistaken for a sentinel and dropped by strip().
function isSentinel(item) {
  return isRecord(item) && typeof item[SENTINEL_KEY] === "string" &&
    SENTINEL_RE.test(item[SENTINEL_KEY]);
}

function hashOf(array) {
  return crypto.createHash("sha256").update(serialized(array)).digest("hex").slice(0, 16);
}

// CCR is deliberately narrower than arbitrary JavaScript. This makes the cache
// contract exact: the bytes hashed, stored, and replayed describe the same value.
function serialized(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("ccr only supports finite JSON numbers");
    return JSON.stringify(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) throw new TypeError(`ccr only supports JSON values, got ${typeof value}`);
  if (seen.has(value)) throw new TypeError("ccr does not support cyclic values");
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError("ccr does not support sparse arrays");
    for (const item of value) serialized(item, seen);
  } else {
    for (const item of Object.values(value)) serialized(item, seen);
  }
  seen.delete(value);
  return JSON.stringify(value);
}

function evenly(items, k) {
  if (items.length <= k) return items;
  const step = items.length / k;
  return Array.from({ length: k }, (_, i) => items[Math.floor(i * step)]);
}

// The categorical string field to watch for transitions — the lowest-cardinality
// one (a `level` of warn/info), not a per-row unique id whose every pair would
// look like a change and burn the anomaly budget on noise.
function changeKey(array) {
  const first = array.find(isRecord);
  if (!first) return null;
  const counts = Object.keys(first)
    .filter((k) => typeof first[k] === "string")
    .map((k) => [k, new Set(array.filter(isRecord).map((r) => r[k])).size])
    .filter(([, card]) => card > 1)
    .sort((a, b) => a[1] - b[1]);
  return counts.length ? counts[0][0] : null;
}

// Change-points on that field — the rows a log is read for (a `warn` between
// `info`s). Both sides of each transition.
function changePoints(array) {
  const key = changeKey(array);
  if (!key) return [];
  const cp = new Set();
  for (let i = 1; i < array.length; i++) {
    const prev = array[i - 1];
    const cur = array[i];
    if (isRecord(prev) && isRecord(cur) && prev[key] !== cur[key]) {
      cp.add(i - 1);
      cp.add(i);
    }
  }
  return [...cp].sort((a, b) => a - b);
}

function hasValue(record, key) {
  return Object.hasOwn(record, key) && record[key] !== null && record[key] !== undefined && record[key] !== false;
}

// These rows are semantic boundaries, not statistical guesses. Keep them even
// when a caller's item budget is exhausted: an error, explicit tag/outlier, or
// one half of a tool exchange must not be shown without its useful context.
function protectedIndices(array) {
  const protectedRows = new Set();
  const toolGroups = new Map();
  const toolIds = ["tool_call_id", "tool_use_id", "call_id", "toolCallId"];
  for (let i = 0; i < array.length; i++) {
    const row = array[i];
    if (!isRecord(row)) continue;
    if (hasValue(row, "error") || hasValue(row, "errors") || hasValue(row, "tag") ||
      hasValue(row, "tags") || hasValue(row, "outlier") || hasValue(row, "is_outlier") ||
      hasValue(row, "anomaly") || ["error", "fatal"].includes(row.level)) protectedRows.add(i);
    const id = toolIds.map((key) => row[key]).find((value) => typeof value === "string" && value);
    if (id) {
      const group = toolGroups.get(id) ?? [];
      group.push(i);
      toolGroups.set(id, group);
    }
  }
  // Any selected member brings its full tool group; adding every group here is
  // conservative and avoids showing a call/result pair as unrelated fragments.
  for (const group of toolGroups.values()) for (const i of group) protectedRows.add(i);
  return [...protectedRows].sort((a, b) => a - b);
}

// Within a `maxItems` budget: keep the endpoints as anchors, spend the rest on
// anomalies first (the signal), then backfill with head/tail context. Anomalies
// are preserved preferentially instead of being diluted by even downsampling.
function selectIndices(array, cfg) {
  const n = array.length;
  const keep = new Set([0, n - 1]);

  for (const i of protectedIndices(array)) keep.add(i);

  for (const i of evenly(changePoints(array), cfg.maxItems - keep.size)) {
    if (keep.size >= cfg.maxItems) break;
    keep.add(i);
  }

  const head = Math.max(1, Math.floor(n * cfg.firstFraction));
  const tail = Math.max(1, Math.floor(n * cfg.lastFraction));
  const filler = [];
  for (let i = 0; i < head; i++) filler.push(i);
  for (let i = n - tail; i < n; i++) filler.push(i);
  for (const i of evenly(filler, cfg.maxItems)) {
    if (keep.size >= cfg.maxItems) break;
    keep.add(i);
  }

  return [...keep].sort((a, b) => a - b);
}

function countTokens(count, value) {
  const observed = count(value);
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
    throw new TypeError("ccr tokenCount must return a finite non-negative number");
  }
  return observed;
}

function exactCached(cache, hash, source) {
  if (!cache || typeof cache.put !== "function" || typeof cache.get !== "function") return false;
  const snapshot = JSON.parse(serialized(source));
  cache.put(hash, snapshot);
  const recovered = cache.get(hash);
  return Array.isArray(recovered) && serialized(recovered) === serialized(source);
}

// crush(array, { tokenCount, cache }) -> { view, hash, dropped }
//   view    : sampled items + a sentinel `{_ccr:"<<ccr:HASH N_rows_offloaded>>"}`
//   hash    : cache key for the originals, or null when nothing was dropped
//   dropped : count of items offloaded
// A tokenCount callback is mandatory for loss: it sees the final view including
// the marker, and compression proceeds only when it is strictly smaller. Cache
// storage is verified before returning a marker, so replay is exact or no loss
// occurs. Passthrough preserves the original array reference.
function crush(array, options) {
  if (!Array.isArray(array)) throw new TypeError("ccr.crush expects an array");
  const cfg = { ...DEFAULTS, ...options };
  if (array.length < cfg.minItems) return { view: array, hash: null, dropped: 0 };

  const idx = selectIndices(array, cfg);
  if (idx.length >= array.length) return { view: array, hash: null, dropped: 0 };

  const hash = hashOf(array);
  const dropped = array.length - idx.length;
  const view = idx.map((i) => array[i]);
  view.push({ [SENTINEL_KEY]: `<<ccr:${hash} ${dropped}_rows_offloaded>>` });
  if (typeof cfg.tokenCount !== "function") return { view: array, hash: null, dropped: 0 };
  if (countTokens(cfg.tokenCount, view) >= countTokens(cfg.tokenCount, array)) {
    return { view: array, hash: null, dropped: 0 };
  }
  if (!exactCached(cfg.cache, hash, array)) return { view: array, hash: null, dropped: 0 };
  return { view, hash, dropped };
}

// Return the original exact snapshot for a CCR result. A hash mismatch is a
// cache corruption/error, never a best-effort replay of unrelated data.
function replay(result, cache) {
  if (!result || !Array.isArray(result.view)) throw new TypeError("ccr.replay expects a crush result");
  if (result.hash === null) return result.view;
  if (typeof result.hash !== "string" || !cache || typeof cache.get !== "function") {
    throw new TypeError("ccr replay requires a retrievable cache");
  }
  const recovered = cache.get(result.hash);
  if (!Array.isArray(recovered) || hashOf(recovered) !== result.hash) {
    throw new Error(`ccr cache miss or corruption for ${result.hash}`);
  }
  return recovered;
}

// Passive evaluator only: callers supply already-observed prefix identities and
// provider cache token counters. It neither constructs nor rewrites requests.
function evaluateCacheStability(observations) {
  if (!Array.isArray(observations)) throw new TypeError("ccr.evaluateCacheStability expects an array");
  const known = observations.map((observation) => {
    if (!isRecord(observation)) throw new TypeError("ccr cache observation must be an object");
    const tokens = observation.cacheReadTokens ?? observation.cachedInputTokens;
    if (tokens !== undefined && (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)) {
      throw new TypeError("ccr cache token usage must be a non-negative safe integer");
    }
    return { prefix: observation.prefix, tokens };
  });
  const stablePrefix = known.length > 0 && known.every((item) => item.prefix === known[0].prefix);
  const samples = known.filter((item) => item.tokens !== undefined);
  if (!stablePrefix || samples.length < 2) {
    return { stablePrefix, cacheTokenDrift: undefined, sampleCount: samples.length };
  }
  return {
    stablePrefix,
    cacheTokenDrift: samples.at(-1).tokens - samples[0].tokens,
    sampleCount: samples.length,
  };
}

// Drop sentinels from a crushed view so callers iterating records don't trip
// on marker entries.
function strip(view) {
  return Array.isArray(view) ? view.filter((x) => !isSentinel(x)) : view;
}

export { crush, replay, strip, isSentinel, hashOf, evaluateCacheStability, SENTINEL_KEY, DEFAULTS };

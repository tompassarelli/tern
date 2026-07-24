import { performance } from "node:perf_hooks";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_JSONL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_JSONL_FRAMES = 100_000;

export interface StrictJsonLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface StrictJsonlLimits {
  label?: string;
  maxLineBytes?: number;
  maxTotalBytes?: number;
  maxFrames?: number;
  /** Refill the byte/frame ceilings over this interval instead of charging them for life. */
  rollingWindowMs?: number;
  /** Test-only monotonic clock seam for rolling accounting. */
  nowMs?: () => number;
}

export function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`${label} contains ill-formed Unicode`);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains ill-formed Unicode`);
    }
  }
}

function inspectParsedValue(
  value: unknown,
  label: string,
  maxDepth: number,
  maxNodes: number,
): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > maxNodes) throw new Error(`${label} exceeds the bounded JSON node count`);
    if (depth > maxDepth) throw new Error(`${label} exceeds the bounded JSON nesting depth`);
    if (typeof current === "string") {
      assertWellFormedUnicode(current, label);
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        assertWellFormedUnicode(key, label);
        visit(entry, depth + 1);
      }
    }
  };
  visit(value, 0);
}

/**
 * Parse one bounded JSON document while rejecting duplicate object members.
 * JSON.parse alone is deliberately insufficient: it silently applies a
 * last-member-wins policy that can change an authority-bearing envelope.
 */
export function parseStrictJson(
  text: string,
  label: string,
  limits: StrictJsonLimits = {},
): unknown {
  assertWellFormedUnicode(text, label);
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES;
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new Error(`${label} exceeds the bounded JSON byte size`);

  const stack: Array<{ kind: "object"; keys: Set<string> } | { kind: "array" }> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === "\"") {
      const start = index;
      let escaped = false;
      for (index++; index < text.length; index++) {
        const stringCharacter = text[index]!;
        if (escaped) escaped = false;
        else if (stringCharacter === "\\") escaped = true;
        else if (stringCharacter === "\"") break;
      }
      if (index >= text.length) throw new Error(`${label} is invalid JSON`);
      let next = index + 1;
      while (/[ \t\r\n]/.test(text[next] ?? "")) next++;
      const context = stack.at(-1);
      if (text[next] === ":" && context?.kind === "object") {
        let key: unknown;
        try { key = JSON.parse(text.slice(start, index + 1)); }
        catch { throw new Error(`${label} is invalid JSON`); }
        if (typeof key !== "string") throw new Error(`${label} is invalid JSON`);
        if (context.keys.has(key)) throw new Error(`${label} contains duplicate object keys`);
        context.keys.add(key);
      }
    } else if (character === "{") {
      stack.push({ kind: "object", keys: new Set() });
      if (stack.length > maxDepth) throw new Error(`${label} exceeds the bounded JSON nesting depth`);
    } else if (character === "[") {
      stack.push({ kind: "array" });
      if (stack.length > maxDepth) throw new Error(`${label} exceeds the bounded JSON nesting depth`);
    } else if (character === "}" || character === "]") {
      stack.pop();
    }
  }

  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new Error(`${label} is invalid JSON`); }
  inspectParsedValue(parsed, label, maxDepth, maxNodes);
  return parsed;
}

/**
 * Incremental, fatal UTF-8 JSONL framing with a per-line bound and either
 * lifetime or token-bucket byte/frame ceilings. A non-newline-terminated tail
 * is never a frame.
 */
export class StrictJsonlFrames {
  private fragments: Buffer[] = [];
  private bufferedBytes = 0;
  private totalBytes = 0;
  private frameCount = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly label: string;
  private readonly maxLineBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFrames: number;
  private readonly rollingWindowMs?: number;
  private readonly nowMs: () => number;
  private rollingByteTokens = 0;
  private rollingFrameTokens = 0;
  private rollingUpdatedAt = 0;

  constructor(limits: StrictJsonlLimits = {}) {
    this.label = limits.label ?? "Codex app-server";
    this.maxLineBytes = limits.maxLineBytes ?? DEFAULT_MAX_BYTES;
    this.maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_JSONL_BYTES;
    this.maxFrames = limits.maxFrames ?? DEFAULT_MAX_JSONL_FRAMES;
    this.rollingWindowMs = limits.rollingWindowMs;
    this.nowMs = limits.nowMs ?? (() => performance.now());
    for (const [name, value] of [
      ["maxLineBytes", this.maxLineBytes],
      ["maxTotalBytes", this.maxTotalBytes],
      ["maxFrames", this.maxFrames],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive safe integer`);
    }
    if (this.rollingWindowMs !== undefined) {
      if (!Number.isSafeInteger(this.rollingWindowMs) || this.rollingWindowMs <= 0)
        throw new Error("rollingWindowMs must be a positive safe integer");
      const now = this.nowMs();
      if (!Number.isFinite(now)) throw new Error("nowMs must return a finite number");
      this.rollingByteTokens = this.maxTotalBytes;
      this.rollingFrameTokens = this.maxFrames;
      this.rollingUpdatedAt = now;
    }
  }

  private refillRolling(): void {
    if (this.rollingWindowMs === undefined) return;
    const now = this.nowMs();
    if (!Number.isFinite(now) || now < this.rollingUpdatedAt)
      throw new Error(`${this.label} JSONL rolling clock is invalid`);
    const elapsed = now - this.rollingUpdatedAt;
    this.rollingUpdatedAt = now;
    this.rollingByteTokens = Math.min(
      this.maxTotalBytes,
      this.rollingByteTokens + (elapsed * this.maxTotalBytes) / this.rollingWindowMs,
    );
    this.rollingFrameTokens = Math.min(
      this.maxFrames,
      this.rollingFrameTokens + (elapsed * this.maxFrames) / this.rollingWindowMs,
    );
  }

  private chargeBytes(bytes: number): void {
    if (this.rollingWindowMs !== undefined) {
      if (bytes > this.rollingByteTokens)
        throw new Error(`${this.label} JSONL output exceeded its rolling byte-rate bound`);
      this.rollingByteTokens -= bytes;
      return;
    }
    this.totalBytes += bytes;
    if (!Number.isSafeInteger(this.totalBytes) || this.totalBytes > this.maxTotalBytes)
      throw new Error(`${this.label} JSONL output exceeded its cumulative byte bound`);
  }

  private chargeFrame(): void {
    if (this.rollingWindowMs !== undefined) {
      if (this.rollingFrameTokens < 1)
        throw new Error(`${this.label} JSONL output exceeded its rolling frame-rate bound`);
      this.rollingFrameTokens -= 1;
      return;
    }
    this.frameCount++;
    if (this.frameCount > this.maxFrames)
      throw new Error(`${this.label} JSONL output exceeded its frame-count bound`);
  }

  push(chunk: Uint8Array): readonly string[] {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.refillRolling();
    this.chargeBytes(incoming.byteLength);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = incoming.indexOf(0x0a, start);
      if (newline < 0) break;
      const segment = incoming.subarray(start, newline);
      if (this.bufferedBytes + segment.byteLength > this.maxLineBytes) {
        const bound = this.maxLineBytes === 1024 * 1024
          ? "1 MiB"
          : `${this.maxLineBytes} bytes`;
        throw new Error(`${this.label} JSONL response exceeded ${bound}`);
      }
      if (segment.byteLength) {
        this.fragments.push(segment);
        this.bufferedBytes += segment.byteLength;
      }
      const rawLine = this.fragments.length === 1
        ? this.fragments[0]!
        : Buffer.concat(this.fragments, this.bufferedBytes);
      this.fragments = [];
      this.bufferedBytes = 0;
      let line: string;
      try { line = this.decoder.decode(rawLine); }
      catch { throw new Error(`${this.label} emitted invalid UTF-8 JSONL output`); }
      if (!/^[ \t\r]*$/.test(line)) {
        this.chargeFrame();
        lines.push(line);
      }
      start = newline + 1;
    }
    const remainder = incoming.subarray(start);
    if (this.bufferedBytes + remainder.byteLength > this.maxLineBytes) {
      const bound = this.maxLineBytes === 1024 * 1024
        ? "1 MiB"
        : `${this.maxLineBytes} bytes`;
      throw new Error(`${this.label} JSONL response exceeded ${bound}`);
    }
    if (remainder.byteLength) {
      this.fragments.push(remainder);
      this.bufferedBytes += remainder.byteLength;
    }
    return lines;
  }

  finish(): void {
    if (this.bufferedBytes)
      throw new Error(`${this.label} closed with a partial JSONL frame`);
  }
}

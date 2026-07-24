// Minimal TypeScript client for the North coordinator's EDN wire protocol
// (cli/coord.clj). Shared by the managed-writer fast path and the provider-
// catalog warm cache so neither has to spawn a bb/JVM for a hot-path read or
// write. It speaks EXACTLY the fenced request/response coord.clj uses: connect,
// write one EDN line wrapped in a {:op :for-log ...} envelope + newline, read
// one EDN reply line, close. Every op fails closed to a rejected Promise; the
// callers translate that into a subprocess fallback, so a wire mismatch is a
// performance regression, never a correctness one.
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export class Keyword {
  constructor(readonly name: string) {}
}
export const kw = (name: string) => new Keyword(name);
/** An ordered EDN map is encoded from [Keyword, value] pairs. */
export type OpPairs = Array<[Keyword, unknown]>;
export type EdnMap = Record<string, unknown>;

export function ednEncode(value: unknown): string {
  if (value instanceof Keyword) return `:${value.name}`;
  if (typeof value === "string") return ednString(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("EDN encode: non-integer");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "nil";
  if (Array.isArray(value)) {
    if (value.length > 0 && Array.isArray(value[0]) && value[0][0] instanceof Keyword) {
      return `{${(value as OpPairs)
        .map(([k, v]) => `${ednEncode(k)} ${ednEncode(v)}`)
        .join(" ")}}`;
    }
    return `[${value.map(ednEncode).join(" ")}]`;
  }
  throw new Error("EDN encode: unsupported value");
}

function ednString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** Recursive-descent reader for the bounded EDN grammar coord.clj emits. */
export function ednDecode(text: string): unknown {
  let i = 0;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",";
  const readString = (): string => {
    i++;
    let out = "";
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "\\") out += "\\";
        else if (e === '"') out += '"';
        else if (e === "u") { out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
        else out += e;
      } else out += c;
    }
    throw new Error("EDN decode: unterminated string");
  };
  const readToken = (): string => {
    const start = i;
    while (i < text.length && !isWs(text[i]) && !"{}[]()\"".includes(text[i])) i++;
    return text.slice(start, i);
  };
  const skipWs = () => { while (i < text.length && isWs(text[i])) i++; };
  const readValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === undefined) throw new Error("EDN decode: unexpected end");
    if (c === '"') return readString();
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skipWs();
        if (text[i] === "}") { i++; return obj; }
        const key = readValue();
        const keyName = key instanceof Keyword ? `:${key.name}` : String(key);
        obj[keyName] = readValue();
      }
    }
    if (c === "[" || c === "(") {
      const close = c === "[" ? "]" : ")";
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipWs();
        if (text[i] === close) { i++; return arr; }
        arr.push(readValue());
      }
    }
    if (c === ":") { i++; return new Keyword(readToken()); }
    if (c === "#") {
      i++;
      if (text[i] === "{") { i++; const arr: unknown[] = []; for (;;) { skipWs(); if (text[i] === "}") { i++; return arr; } arr.push(readValue()); } }
      readToken();
      return null;
    }
    const tok = readToken();
    if (tok === "nil") return null;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
    if (/^-?\d+\.\d+$/.test(tok)) return parseFloat(tok);
    return tok;
  };
  return readValue();
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** MUST match cli/coord.clj expected-log so the daemon accepts the :for-log fence. */
export function expectedLog(): string {
  const explicit = process.env.FRAM_LOG;
  const home = process.env.HOME ?? homedir();
  const requested = explicit ?? resolve(home, ".local/state/north/facts.log");
  const split = resolve(dirname(requested), "coordination.log");
  let selected = requested;
  if (!explicit && !process.env.FRAM_TELEMETRY_LOG) {
    try { if (realpathSync(split)) selected = split; } catch { /* no split log */ }
  }
  return canonical(selected);
}

export function coordPort(): number {
  return parseInt(process.env.NORTH_PORT ?? "7977", 10);
}

/** One fenced request/response over a fresh TCP connection (coord.clj send-envelope). */
export function sendOp(port: number, log: string, op: OpPairs, deadline: number): Promise<EdnMap> {
  const envelope: OpPairs = [
    [kw("op"), kw("for-log")],
    [kw("expected-log"), log],
    [kw("request"), op],
  ];
  const wire = `${ednEncode(envelope)}\n`;
  return new Promise((resolvePromise, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    let buf = "";
    const done = (err: Error | null, value?: EdnMap) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolvePromise(value!);
    };
    socket.setTimeout(remaining);
    socket.on("timeout", () => done(new Error("coord-wire: socket timeout")));
    socket.on("error", (e) => done(e));
    socket.on("connect", () => { socket.write(wire, "utf8"); });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          const parsed = ednDecode(buf.slice(0, nl));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            done(new Error("coord-wire: non-map response"));
          } else done(null, parsed as EdnMap);
        } catch (e) { done(e as Error); }
      }
    });
    socket.on("close", () => done(new Error("coord-wire: closed before response")));
  });
}

/** Fields for the coordinator's atomic managed-agent identity publication
 * (cli/coord_daemon.clj :managed-agent-publish). The North identity vocabulary
 * (which predicates feed the manifest, which merely guard the clean-fresh gate)
 * is the CALLER's concern — this codec only frames the one wire op. */
export interface ManagedAgentPublishFields {
  entity: string;
  /** [predicate, value] pairs; encoded as [{:p .. :r ..} ...]. Must omit the marker. */
  facts: Array<[string, string]>;
  /** Every predicate participating in the manifest digest. */
  identityPreds: readonly string[];
  /** Extra predicates whose absence the clean-fresh gate also verifies. */
  guardPreds: readonly string[];
  /** Caller-computed manifest digest; the daemon recomputes and refuses a mismatch. */
  marker: string;
  holder: string;
  ttlMs: number;
}

/** Send ONE :managed-agent-publish op — the server-side composition that
 * derives/acquires the per-subject lease, commits the full body + manifest in a
 * single transaction, verifies exact readback, and releases the lease. Returns
 * the parsed reply map (fails closed to a rejected Promise on any transport
 * error, exactly like every other verb here). */
export function sendManagedAgentPublish(
  port: number, log: string, f: ManagedAgentPublishFields, deadline: number,
): Promise<EdnMap> {
  const factMaps: OpPairs[] = f.facts.map(([p, r]) => [[kw("p"), p], [kw("r"), r]]);
  return sendOp(port, log, [
    [kw("op"), kw("managed-agent-publish")],
    [kw("te"), f.entity],
    [kw("holder"), f.holder],
    [kw("ttl-ms"), f.ttlMs],
    [kw("facts"), factMaps],
    [kw("identity-preds"), [...f.identityPreds]],
    [kw("guard-preds"), [...f.guardPreds]],
    [kw("manifest-sha256"), f.marker],
  ], deadline);
}

/** Live values of (te,p), or null on any transport/parse failure. */
export async function coordResolved(te: string, p: string, timeoutMs: number): Promise<string[] | null> {
  try {
    const r = await sendOp(coordPort(), expectedLog(),
      [[kw("op"), kw("resolved")], [kw("te"), te], [kw("p"), p]],
      Date.now() + Math.max(1, timeoutMs));
    const values = r[":values"];
    if (!Array.isArray(values)) return [];
    return values.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

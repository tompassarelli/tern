import { Socket } from "net";

export interface Claim {
  predicate: string;
  value: string;
}

// EDN-over-TCP client for lodestar coordinator daemon (:7977).
// Same wire protocol the bb CLIs use: write one EDN map per line, read one EDN response.
export async function lodestarQuery(
  port: number,
  op: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = "";
    sock.connect(port, "127.0.0.1", () => {
      const edn = prToStr(op);
      sock.write(edn + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(buf.trim());
      }
    });
    sock.on("error", reject);
    sock.on("timeout", () => reject(new Error("lodestar timeout")));
    sock.setTimeout(5000);
  });
}

function prToStr(obj: Record<string, string>): string {
  const pairs = Object.entries(obj)
    .map(([k, v]) => `:${k} "${v.replace(/"/g, '\\"')}"`)
    .join(" ");
  return `{${pairs}}`;
}

export function parseClaims(raw: string): Claim[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

export async function getThreadClaims(
  port: number,
  threadId: string
): Promise<Claim[]> {
  const raw = await lodestarQuery(port, { op: "show", id: threadId });
  return parseClaims(raw);
}

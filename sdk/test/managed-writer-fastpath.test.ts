// Focused proof that the managed-writer fast path issues ONE atomic
// :managed-agent-publish wire op for a fresh publish (thread 019f9374), with a
// clean capability fallback to the legacy per-predicate sequence when a
// coordinator does not advertise the op. A fake TCP coordinator speaks the same
// EDN wire codec (coord-wire) the fast path uses, so these assertions exercise
// the real transport, not a mock of it.
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { Keyword, ednDecode, ednEncode, type OpPairs } from "../src/coord-wire";
import {
  fastPublish,
  identityMarker,
  normalizeAgentEntity,
} from "../src/managed-writer-fastpath";

const PRESET: Record<string, string> = {
  kind: "lane",
  role: "integrator",
  goal: "prove atomic publication",
  provider: "anthropic",
  provider_target: "claude-a",
  live_input: "streaming",
  live_input_state: "armed",
  live_input_epoch: "00000000-0000-4000-8000-000000000101",
  model: "claude-opus-4-8",
  effort: "high",
  composition_kind: "preset",
  composition_id: "integrator",
  composition_overrides: "[\"tier\"]",
  repo: "north",
  spawned_at: "2026-07-17T01:00:00Z",
  display_handle: "anthropic-a-opus-high-integrator",
  display_name: "anthropic:claude-a · opus · high · gaffer:integrator",
};

const opName = (value: unknown): string | undefined =>
  value instanceof Keyword ? value.name : undefined;

interface FakeCoordinator {
  server: Server;
  port: number;
  requests: string[];
}

// A minimal stateful coordinator. `supportsAtomic` toggles whether
// :managed-agent-publish is served or answered with the pre-op {:error "unknown
// op"} that a legacy coordinator's default dispatch arm returns.
async function startCoordinator(
  supportsAtomic: boolean,
  atomicReply: (req: Record<string, unknown>, entity: string, marker: string) => OpPairs,
): Promise<FakeCoordinator> {
  const requests: string[] = [];
  const store = new Map<string, string[]>(); // predicate -> values
  let epoch = 0;

  const handle = (request: Record<string, unknown>): OpPairs => {
    const op = opName(request[":op"]);
    requests.push(op ?? "?");
    switch (op) {
      case "acquire-lease":
        epoch += 1;
        return [[new Keyword("ok"), true], [new Keyword("epoch"), epoch]];
      case "release-lease":
        return [[new Keyword("ok"), true]];
      case "resolved": {
        const p = String(request[":p"]);
        return [[new Keyword("values"), store.get(p) ?? []]];
      }
      case "assert-with-fence": {
        store.set(String(request[":p"]), [String(request[":r"])]);
        return [[new Keyword("ok"), epoch]];
      }
      case "managed-agent-publish": {
        const entity = normalizeAgentEntity(String(request[":te"]))!;
        const marker = String(request[":manifest-sha256"]);
        if (!supportsAtomic) return [[new Keyword("error"), "unknown op"]];
        return atomicReply(request, entity, marker);
      }
      default:
        return [[new Keyword("error"), "unknown op"]];
    }
  };

  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const envelope = ednDecode(line) as Record<string, unknown>;
        const request = envelope[":request"] as Record<string, unknown>;
        socket.write(`${ednEncode(handle(request))}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, requests };
}

const saved = {
  port: process.env.NORTH_PORT,
  log: process.env.FRAM_LOG,
  disable: process.env.NORTH_MANAGED_WRITER_FASTPATH,
  redirect: process.env.NORTH_IDENTITY_TEST_REDIRECT,
};
let active: FakeCoordinator | undefined;

afterEach(async () => {
  if (active) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = undefined;
  }
  for (const [key, value] of [
    ["NORTH_PORT", saved.port],
    ["FRAM_LOG", saved.log],
    ["NORTH_MANAGED_WRITER_FASTPATH", saved.disable],
    ["NORTH_IDENTITY_TEST_REDIRECT", saved.redirect],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function pointAt(port: number): void {
  process.env.NORTH_PORT = String(port);
  // A fixed literal log the fake echoes back verbatim; no on-disk coordination.log.
  process.env.FRAM_LOG = "/tmp/north-fastpath-test.log";
  delete process.env.NORTH_MANAGED_WRITER_FASTPATH;
  delete process.env.NORTH_IDENTITY_TEST_REDIRECT;
}

test("fresh publish issues exactly one atomic :managed-agent-publish op", async () => {
  const marker = identityMarker(PRESET);
  active = await startCoordinator(true, (_req, entity, replyMarker) => {
    expect(replyMarker).toBe(marker); // caller-computed digest is byte-identical
    return [
      [new Keyword("ok"), 1],
      [new Keyword("fenced-publish"), true],
      [new Keyword("batch"), true],
      [new Keyword("te"), entity],
      [new Keyword("marker"), replyMarker],
      [new Keyword("resource"), "managed-agent-write:x"],
    ];
  });
  pointAt(active.port);

  const result = await fastPublish(
    "agent:atomic-probe", PRESET, "managed-agent-writer:h", "op-1", 5_000,
  );

  expect(result).toEqual({ status: "committed", operationId: "op-1" });
  expect(active.requests).toEqual(["managed-agent-publish"]);
  expect(active.requests).not.toContain("assert-with-fence");
});

test("unknown-op coordinator falls back to the legacy fenced-wire sequence", async () => {
  active = await startCoordinator(false, () => []);
  pointAt(active.port);

  const result = await fastPublish(
    "agent:legacy-probe", PRESET, "managed-agent-writer:h", "op-2", 5_000,
  );

  expect(result).toEqual({ status: "committed", operationId: "op-2" });
  // The atomic op is tried first, then the legacy sequence carries the publish.
  expect(active.requests[0]).toBe("managed-agent-publish");
  expect(active.requests).toContain("assert-with-fence");
  expect(active.requests.filter((op) => op === "assert-with-fence").length)
    .toBeGreaterThan(1);
});

test("a coordinator reject fails closed to the subprocess (null)", async () => {
  active = await startCoordinator(true, () => [[new Keyword("reject"), new Keyword("publish-conflict")]]);
  pointAt(active.port);

  const result = await fastPublish(
    "agent:conflict-probe", PRESET, "managed-agent-writer:h", "op-3", 5_000,
  );

  expect(result).toBeNull();
  expect(active.requests).toEqual(["managed-agent-publish"]);
});

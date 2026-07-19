import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { admitExecution, admitPinnedProvider } from "../src/execution-admission";
import { gatedTest } from "./support/capabilities";

const inheritedPort = process.env.NORTH_PORT;
afterEach(() => {
  if (inheritedPort === undefined) delete process.env.NORTH_PORT;
  else process.env.NORTH_PORT = inheritedPort;
});

const directorCapabilities = [
  "filesystem.read", "filesystem.search", "shell.readonly", "web", "coordination",
] as const;

test("a pinned OpenAI orchestrator is blocked before a provider turn", () => {
  try {
    admitPinnedProvider("openai", directorCapabilities);
    throw new Error("expected preflight block");
  } catch (error) {
    expect(error).toMatchObject({
      code: "blocked_preflight",
      processOutcome: "blocked_preflight",
      retrySafeBeforeAcceptance: true,
    });
  }
});

test("OpenAI web authority is rejected when pinned and remains auto-routable", () => {
  const webCapabilities = [
    "filesystem.read", "filesystem.search", "shell.readonly", "web",
  ] as const;
  expect(() => admitPinnedProvider("auto", webCapabilities)).not.toThrow();
  expect(() => admitPinnedProvider(undefined, webCapabilities)).not.toThrow();
  expect(() => admitPinnedProvider("openai", webCapabilities))
    .toThrow("openai_adapter_web_capability_unproven");
});

test("every managed lane requires a live North coordinator before a provider turn", async () => {
  process.env.NORTH_PORT = "65534";
  for (const capabilities of [
    directorCapabilities,
    ["filesystem.read", "filesystem.search", "shell.readonly"] as const,
  ]) {
    await expect(admitExecution(
      "anthropic", capabilities, process.cwd(),
      { mcpServers: { north: { env: { NORTH_PORT: "65534", FRAM_LOG: "/tmp/north-admission.log" } } } },
    ))
      .rejects.toMatchObject({
        code: "blocked_preflight",
        processOutcome: "blocked_preflight",
        retrySafeBeforeAcceptance: true,
      });
  }
});

gatedTest("loopback-bind", "admission never falls back to a later ambient North port", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("{:version \"ambient-must-not-win\"}\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  process.env.NORTH_PORT = String((server.address() as AddressInfo).port);
  try {
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      { mcpServers: { north: { env: {} } } },
    )).rejects.toThrow("north_coordination_port_missing");
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
    )).rejects.toThrow("north_coordination_port_missing");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

gatedTest("loopback-bind", "admission rejects non-canonical corpus identities before opening a socket", async () => {
  let accepts = 0;
  const server = createServer((socket) => {
    accepts += 1;
    socket.end("{:version 1}\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = String((server.address() as AddressInfo).port);
  try {
    for (const log of [
      "relative/facts.log",
      "/tmp/../tmp/north-admission.log",
      "/tmp/north-admission.log/",
    ]) {
      await expect(admitExecution(
        "openai",
        ["filesystem.read", "filesystem.search", "shell.readonly"],
        process.cwd(),
        { mcpServers: { north: { env: { NORTH_PORT: port, FRAM_LOG: log } } } },
      )).rejects.toThrow("north_coordination_log_identity_invalid");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accepts).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

gatedTest("loopback-bind", "admission probes the validated lane coordinator port, never a different ambient instance", async () => {
  const requests: string[] = [];
  const expectedLog = "/tmp/north admission corpus.log";
  const server = createServer((socket) => {
    let request = "";
    const onData = (chunk: Buffer) => {
      request += chunk.toString("utf8");
      if (Buffer.byteLength(request, "utf8") > 4096) {
        socket.destroy();
        return;
      }
      if (!request.includes("\n")) return;
      socket.off("data", onData);
      requests.push(request);
      if (request.includes(":for-log")) {
        socket.end("{:version 7}\n");
      } else {
        socket.end(
          `{:reject ["fence required"] :code :log-fence-required :served-log ${JSON.stringify(expectedLog)}}\n`,
        );
      }
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = String((server.address() as AddressInfo).port);
  process.env.NORTH_PORT = "65534";
  const options = {
    mcpServers: {
      north: { env: { NORTH_PORT: port, FRAM_LOG: expectedLog } },
    },
  };
  try {
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      options,
    )).resolves.toBeUndefined();
    expect(requests).toEqual([
      '{:op :for-log, :expected-log "/tmp/north admission corpus.log", :request {:op :version}}\n',
      "{:op :version}\n",
    ]);
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      { mcpServers: { north: { env: { NORTH_PORT: "not-a-port", FRAM_LOG: "/tmp/north-admission.log" } } } },
    )).rejects.toThrow("north_coordination_port_invalid");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

gatedTest("loopback-bind", "admission rejects wrong-log and pre-fence coordinator replies", async () => {
  for (const reply of [
    '{:reject ["wrong log"] :code :log-mismatch}\n',
    '{:error "unknown op"}\n',
    '{:reject ["not admitted"] :version 7}\n',
  ]) {
    const server = createServer((socket) => {
      socket.once("data", () => socket.end(reply));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = String((server.address() as AddressInfo).port);
    try {
      await expect(admitExecution(
        "openai",
        ["filesystem.read", "filesystem.search", "shell.readonly"],
        process.cwd(),
        { mcpServers: { north: { env: { NORTH_PORT: port, FRAM_LOG: "/tmp/expected.log" } } } },
      )).rejects.toThrow("north_coordinator_preflight_invalid_response");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

gatedTest("loopback-bind", "admission bounds an unterminated coordinator response", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.write("x".repeat(4_097)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = String((server.address() as AddressInfo).port);
  try {
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      { mcpServers: { north: { env: { NORTH_PORT: port, FRAM_LOG: "/tmp/expected.log" } } } },
    )).rejects.toThrow("north_coordinator_preflight_invalid_response");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a shell-bearing capability set cannot hide effective file authority", async () => {
  await expect(admitExecution(
    "anthropic",
    ["filesystem.read", "filesystem.search", "shell"],
    process.cwd(),
  )).rejects.toThrow("anthropic_adapter_cannot_enforce_gaffer_capabilities");
  await expect(admitExecution(
    "openai",
    ["shell.readonly"],
    process.cwd(),
  )).rejects.toThrow("openai_adapter_cannot_enforce_gaffer_capabilities");
});

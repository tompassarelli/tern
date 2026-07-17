import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { admitExecution, admitPinnedProvider } from "../src/execution-admission";

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

test("every managed lane requires a live North coordinator before a provider turn", async () => {
  process.env.NORTH_PORT = "65534";
  for (const capabilities of [
    directorCapabilities,
    ["filesystem.read", "filesystem.search", "shell.readonly"] as const,
  ]) {
    await expect(admitExecution(
      "anthropic", capabilities, process.cwd(),
      { mcpServers: { north: { env: { NORTH_PORT: "65534" } } } },
    ))
      .rejects.toMatchObject({
        code: "blocked_preflight",
        processOutcome: "blocked_preflight",
        retrySafeBeforeAcceptance: true,
      });
  }
});

test("admission never falls back to a later ambient North port", async () => {
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

test("admission probes the validated lane coordinator port, never a different ambient instance", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("{:version \"test\"}\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = String((server.address() as AddressInfo).port);
  process.env.NORTH_PORT = "65534";
  const options = { mcpServers: { north: { env: { NORTH_PORT: port } } } };
  try {
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      options,
    )).resolves.toBeUndefined();
    await expect(admitExecution(
      "openai",
      ["filesystem.read", "filesystem.search", "shell.readonly"],
      process.cwd(),
      { mcpServers: { north: { env: { NORTH_PORT: "not-a-port" } } } },
    )).rejects.toThrow("north_coordination_port_invalid");
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

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  corpus_log,
  framRequestRaw,
  port_for,
  subscription_handshake_valid_p,
  wire_envelope,
} from "../out/north/fram.js";
import { api_assert, api_capture } from "../out/north/server.js";

const inheritedLog = process.env.FRAM_LOG;
afterEach(() => {
  if (inheritedLog === undefined) delete process.env.FRAM_LOG;
  else process.env.FRAM_LOG = inheritedLog;
});

test("retired or unknown graph selectors never alias to the board corpus", () => {
  expect(port_for("board", 45_678)).toBe(45_678);
  expect(port_for("code", 45_678)).toBe(0);
  expect(port_for("attention", 45_678)).toBe(0);
  expect(port_for("invented", 45_678)).toBe(0);
});

test("write API rejects retired graph selectors before transport", async () => {
  await expect(api_assert({ graph: "code", te: "@x", p: "x", r: "y" }, 45_678)).resolves.toEqual({
    http: 400,
    body: { error: "unknown or retired graph" },
  });
  await expect(api_capture({ graph: "attention", title: "must not land" }, 45_678)).resolves.toEqual({
    http: 400,
    body: { error: "unknown or retired graph" },
  });
});

test("web requests fail closed without an explicit existing FRAM_LOG", () => {
  delete process.env.FRAM_LOG;
  expect(corpus_log()).toBeNull();
  expect(wire_envelope("{:op :version}")).toBeNull();
});

test("web requests carry the canonical corpus fence and outer JSON format", () => {
  const dir = mkdtempSync(join(tmpdir(), "north-web-fence-"));
  const log = join(dir, "facts log.edn");
  writeFileSync(log, "");
  process.env.FRAM_LOG = log;
  try {
    const canonical = realpathSync(log);
    expect(corpus_log()).toBe(canonical);
    expect(wire_envelope("{:op :version}")).toBe(
      `{:op :for-log :expected-log ${JSON.stringify(canonical)} :request {:op :version} :fmt :json}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription handshake requires exact log identity and integer version", () => {
  const expected = "/tmp/north facts.log";
  expect(subscription_handshake_valid_p(
    '{:subscribed 7, :log "/tmp/north facts.log"}',
    expected,
  )).toBeTrue();
  expect(subscription_handshake_valid_p(
    '{:subscribed 7, :log "/tmp/other.log"}',
    expected,
  )).toBeFalse();
  expect(subscription_handshake_valid_p(
    '{:subscribed "7", :log "/tmp/north facts.log"}',
    expected,
  )).toBeFalse();
  expect(subscription_handshake_valid_p(
    JSON.stringify({ subscribed: 7, log: expected }),
    expected,
  )).toBeFalse();
});

test("one-shot web transport caps an unterminated response", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(Buffer.alloc(16_777_217, 120)));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await expect(framRequestRaw(address.port, "{:op :version}")).resolves.toBeNull();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one-shot web transport preserves split UTF-8 scalars", async () => {
  const expected = '{"ok":"😀"}';
  const bytes = Buffer.from(`${expected}\n`);
  const scalar = bytes.indexOf(Buffer.from("😀"));
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(bytes.subarray(0, scalar + 2));
      setTimeout(() => socket.end(bytes.subarray(scalar + 2)), 5);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await expect(framRequestRaw(address.port, "{:op :version}")).resolves.toBe(expected);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one-shot web transport rejects malformed UTF-8 inside JSON", async () => {
  const invalid = Buffer.concat([
    Buffer.from('{"ok":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}\n'),
  ]);
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(invalid));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await expect(framRequestRaw(address.port, "{:op :version}")).resolves.toBeNull();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one-shot web transport rejects EOF before the response newline", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end('{"version":1}'));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await expect(framRequestRaw(address.port, "{:op :version}")).resolves.toBeNull();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one-shot web transport rejects a second response line", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end('{"version":1}\n{"version":2}\n'));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await expect(framRequestRaw(address.port, "{:op :version}")).resolves.toBeNull();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

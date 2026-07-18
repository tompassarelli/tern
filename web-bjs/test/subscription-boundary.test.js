import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NORTH_WEB_NO_AUTOSTART = "1";
const configuredPort = 45_678;
const originalPort = process.env.NORTH_PORT;
process.env.NORTH_PORT = String(configuredPort);
const {
  configuredBoardPort,
  fetchHandler,
  startServer,
  startSubscribe,
} = await import("../out/north/boot.js");

const originalConnect = Bun.connect;
const originalServe = Bun.serve;
const originalLog = process.env.FRAM_LOG;
const controllers = [];
const dirs = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  Bun.connect = originalConnect;
  Bun.serve = originalServe;
  if (originalLog === undefined) delete process.env.FRAM_LOG;
  else process.env.FRAM_LOG = originalLog;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalPort === undefined) delete process.env.NORTH_PORT;
  else process.env.NORTH_PORT = originalPort;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installFakeConnect() {
  const attempts = [];
  Bun.connect = (options) => {
    const socket = {
      writes: [],
      terminations: 0,
      write(value) {
        this.writes.push(value);
      },
      terminate() {
        this.terminations += 1;
      },
    };
    attempts.push({ handlers: options.socket, port: options.port, socket });
    queueMicrotask(() => options.socket.open(socket));
    return Promise.resolve(socket);
  };
  return attempts;
}

function installProtocolConnect() {
  const attempts = [];
  Bun.connect = (options) => {
    const socket = {
      terminate() {},
      write(request) {
        attempts.push({ port: options.port, request });
        const payload = request.includes(":op :subscribe")
          ? null
          : request.includes(":op :resolved")
            ? '{"value":"@agent:configured-port"}\n'
            : request.includes(":op :version")
              ? '{"version":1}\n'
              : request.includes(":op :query")
                ? '{"ok":[]}\n'
                : '{"ok":true}\n';
        if (payload !== null) {
          queueMicrotask(() => {
            options.socket.data(socket, Buffer.from(payload));
            options.socket.close(socket);
          });
        }
      },
    };
    queueMicrotask(() => options.socket.open(socket));
    return Promise.resolve(socket);
  };
  return attempts;
}

function configureLog() {
  const dir = mkdtempSync(join(tmpdir(), "north-web-subscription-"));
  const log = join(dir, "facts log.edn");
  writeFileSync(log, "");
  dirs.push(dir);
  process.env.FRAM_LOG = log;
  return realpathSync(log);
}

function handshake(log) {
  return Buffer.from(`{:subscribed 7, :log ${JSON.stringify(log)}}\n`);
}

test("missing FRAM_LOG disables subscription without a reconnect loop", async () => {
  delete process.env.FRAM_LOG;
  const attempts = installFakeConnect();
  const controller = startSubscribe();
  controllers.push(controller);
  await sleep(600);
  expect(attempts).toHaveLength(0);
});

test("board port configuration accepts only an integer from 1 through 65535", () => {
  expect(configuredBoardPort(undefined)).toBe(7977);
  expect(configuredBoardPort(String(configuredPort))).toBe(configuredPort);
  for (const invalid of ["0", "65536", "1.5", "1e3", " 7977", "not-a-port"]) {
    expect(() => configuredBoardPort(invalid)).toThrow(
      "NORTH_PORT must be an integer from 1 through 65535",
    );
  }
});

test("configured non-default port is shared by GET, subscription, POST, and steer", async () => {
  configureLog();
  const attempts = installProtocolConnect();
  const controller = startSubscribe();
  controllers.push(controller);
  const localServer = {
    requestIP: () => ({ address: "127.0.0.1" }),
    upgrade: () => false,
  };

  const get = await fetchHandler(
    new Request("http://north.test/api/entities?graph=board"),
    localServer,
  );
  expect(get.status).toBe(200);

  const post = await fetchHandler(
    new Request("http://north.test/api/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: "board", te: "@port-proof", p: "note", r: "one" }),
    }),
    localServer,
  );
  expect(post.status).toBe(200);

  const steer = await fetchHandler(
    new Request("http://north.test/api/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "configured-port", text: "same coordinator" }),
    }),
    localServer,
  );
  expect(steer.status).toBe(200);

  await sleep(0);
  expect(attempts.some(({ request }) => request.includes(":op :subscribe"))).toBeTrue();
  expect(attempts.some(({ request }) => request.includes(":op :query"))).toBeTrue();
  expect(attempts.filter(({ request }) => request.includes(":op :assert"))).not.toHaveLength(0);
  expect(attempts.some(({ request }) => request.includes("@session:configured-port"))).toBeTrue();
  expect(new Set(attempts.map(({ port }) => port))).toEqual(new Set([configuredPort]));
});

test("explicit server stop retires the active subscription and reconnect timer", async () => {
  configureLog();
  const attempts = installFakeConnect();
  let serverStops = 0;
  Bun.serve = () => ({
    stop() {
      serverStops += 1;
    },
  });

  const server = startServer();
  await sleep(0);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  server.stop();
  expect(serverStops).toBe(1);
  expect(attempt.socket.terminations).toBe(1);
  await sleep(600);
  expect(attempts).toHaveLength(1);
});

test("server startup failure retires the subscription before rethrowing", async () => {
  configureLog();
  const attempts = installFakeConnect();
  Bun.serve = () => {
    throw new Error("listen failed");
  };

  expect(() => startServer()).toThrow("listen failed");
  await sleep(0);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].socket.terminations).toBe(1);
  await sleep(600);
  expect(attempts).toHaveLength(1);
});

test("stale close from a retired socket cannot disturb its replacement", async () => {
  const log = configureLog();
  const attempts = installFakeConnect();
  const controller = startSubscribe();
  controllers.push(controller);
  await sleep(0);
  expect(attempts).toHaveLength(1);

  const first = attempts[0];
  first.handlers.data(first.socket, handshake(log));
  first.handlers.error(first.socket, new Error("first peer dropped"));
  await sleep(550);
  expect(attempts).toHaveLength(2);

  const second = attempts[1];
  second.handlers.data(second.socket, handshake(log));
  first.handlers.close(first.socket);
  // A stale callback would arm the current 1s backoff and create attempt 3.
  await sleep(1100);
  expect(attempts).toHaveLength(2);
  expect(second.socket.terminations).toBe(0);
});

test("a current-generation error before open still arms recovery", async () => {
  configureLog();
  const attempts = [];
  Bun.connect = (options) => {
    const socket = { write() {}, terminate() {} };
    attempts.push({ handlers: options.socket, socket });
    if (attempts.length === 1)
      queueMicrotask(() => options.socket.error(socket, new Error("pre-open failure")));
    else
      queueMicrotask(() => options.socket.open(socket));
    return Promise.resolve(socket);
  };
  const controller = startSubscribe();
  controllers.push(controller);
  await sleep(550);
  expect(attempts).toHaveLength(2);
});

test("subscription cap counts UTF-8 wire bytes, not UTF-16 code units", async () => {
  const log = configureLog();
  const attempts = installFakeConnect();
  const controller = startSubscribe();
  controllers.push(controller);
  await sleep(0);
  const attempt = attempts[0];
  attempt.handlers.data(attempt.socket, handshake(log));
  // 262,145 emoji are 524,290 JS code units but 1,048,580 UTF-8 bytes.
  attempt.handlers.data(attempt.socket, Buffer.from("😀".repeat(262_145)));
  expect(attempt.socket.terminations).toBe(1);
});

test("fatal streaming UTF-8 accepts a split scalar and rejects malformed input", async () => {
  const log = configureLog();
  const attempts = installFakeConnect();
  const controller = startSubscribe();
  controllers.push(controller);
  await sleep(0);
  const attempt = attempts[0];
  attempt.handlers.data(attempt.socket, handshake(log));
  attempt.handlers.data(attempt.socket, Buffer.from([0xf0, 0x9f]));
  attempt.handlers.data(attempt.socket, Buffer.from([0x98, 0x80]));
  expect(attempt.socket.terminations).toBe(0);
  attempt.handlers.data(attempt.socket, Buffer.from([0xc3]));
  attempt.handlers.data(attempt.socket, Buffer.from([0x28]));
  expect(attempt.socket.terminations).toBe(1);
});

import { afterAll, afterEach, expect, test } from "bun:test";

const inherited = {
  allowedOrigins: process.env.NORTH_WEB_ALLOWED_ORIGINS,
  autostart: process.env.NORTH_WEB_NO_AUTOSTART,
  bind: process.env.NORTH_WEB_BIND,
  framLog: process.env.FRAM_LOG,
  port: process.env.PORT,
  staticDir: process.env.STATIC_DIR,
};

process.env.NORTH_WEB_NO_AUTOSTART = "1";
process.env.PORT = "18088";
process.env.NORTH_WEB_ALLOWED_ORIGINS = "https://trusted.example:9443";
delete process.env.NORTH_WEB_BIND;
delete process.env.FRAM_LOG;
delete process.env.STATIC_DIR;

const {
  configuredAllowedOrigins,
  configuredWebBind,
  configuredWebPort,
  fetchHandler,
  isLoopbackPeer,
  isLoopbackWebOrigin,
  readJsonBody,
  requestAuthorized,
  startServer,
  staticAssetRelativePath,
} = await import("../out/north/boot.js?security-boundary");

const originalServe = Bun.serve;

afterEach(() => {
  Bun.serve = originalServe;
});

afterAll(() => {
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("NORTH_WEB_ALLOWED_ORIGINS", inherited.allowedOrigins);
  restore("NORTH_WEB_NO_AUTOSTART", inherited.autostart);
  restore("NORTH_WEB_BIND", inherited.bind);
  restore("FRAM_LOG", inherited.framLog);
  restore("PORT", inherited.port);
  restore("STATIC_DIR", inherited.staticDir);
});

function fakeServer(address, upgrade = () => false) {
  return {
    requestIP: () => address === null ? null : { address },
    upgrade,
  };
}

function request(path, { body, method = "OPTIONS", origin } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://127.0.0.1:18088${path}`, { body, method, headers });
}

test("web port and bind configuration fail closed on malformed values", () => {
  expect(configuredWebPort(undefined)).toBe(8088);
  expect(configuredWebPort("18088")).toBe(18088);
  for (const invalid of ["0", "65536", "1.5", "1e3", " 8088", "not-a-port"]) {
    expect(() => configuredWebPort(invalid)).toThrow(
      "PORT must be an integer from 1 through 65535",
    );
  }

  expect(configuredWebBind(undefined)).toBe("127.0.0.1");
  for (const valid of [
    "localhost",
    "127.0.0.1",
    "127.255.10.4",
    "::1",
  ]) {
    expect(configuredWebBind(valid)).toBe(valid);
  }
  for (const invalid of ["bad host", "http://127.0.0.1", "[::1]", "host/path", "user@host"]) {
    expect(() => configuredWebBind(invalid)).toThrow(
      "NORTH_WEB_BIND must be a valid hostname or IP address",
    );
  }
  for (const remote of ["0.0.0.0", "::", "10.0.0.2", "trusted.example"]) {
    expect(() => configuredWebBind(remote)).toThrow(
      "NORTH_WEB_BIND must be loopback",
    );
  }
});

test("configured CORS origins must be exact canonical http(s) origins", () => {
  expect(configuredAllowedOrigins(undefined).size).toBe(0);
  const configured = configuredAllowedOrigins(
    "http://localhost:18088, https://trusted.example:9443",
  );
  expect([...configured]).toEqual([
    "http://localhost:18088",
    "https://trusted.example:9443",
  ]);

  for (const invalid of [
    "null",
    "ftp://trusted.example:9443",
    "https://trusted.example:9443/",
    "https://trusted.example:9443/path",
    "https://user@trusted.example:9443",
    "http://trusted.example:80",
    "https://trusted.example:443",
  ]) {
    expect(() => configuredAllowedOrigins(invalid)).toThrow();
  }
});

test("loopback recognition covers normalized IPv4 and IPv6 forms only", () => {
  for (const address of [
    "127.0.0.1",
    "127.255.10.4",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:127.0.0.1",
  ]) {
    expect(isLoopbackPeer(address)).toBeTrue();
  }
  for (const address of [
    null,
    "",
    "10.0.0.1",
    "192.168.1.2",
    "::2",
    "::ffff:10.0.0.1",
    "127.999.0.1",
  ]) {
    expect(isLoopbackPeer(address)).toBeFalse();
  }
});

test("default browser trust requires a canonical loopback origin and exact explicit port", () => {
  for (const origin of [
    "http://localhost:18088",
    "https://127.0.0.1:18088",
    "http://127.200.3.4:18088",
    "http://[::1]:18088",
  ]) {
    expect(isLoopbackWebOrigin(origin, 18088)).toBeTrue();
  }
  for (const origin of [
    "null",
    "http://localhost",
    "http://localhost:18089",
    "http://evil.example:18088",
    "http://localhost:18088/",
    "http://localhost:18088/path",
    "http://user@localhost:18088",
  ]) {
    expect(isLoopbackWebOrigin(origin, 18088)).toBeFalse();
  }
});

test("request authorization combines peer identity with origin policy", () => {
  const allowed = configuredAllowedOrigins("https://trusted.example:9443");
  expect(requestAuthorized(null, "127.0.0.1", 18088, allowed)).toBeTrue();
  expect(requestAuthorized(null, "10.0.0.2", 18088, allowed)).toBeFalse();
  expect(requestAuthorized("http://localhost:18088", "::1", 18088, allowed)).toBeTrue();
  expect(requestAuthorized("http://evil.example:18088", "127.0.0.1", 18088, allowed)).toBeFalse();
  expect(requestAuthorized("http://localhost:18088", "10.0.0.2", 18088, allowed)).toBeFalse();
  expect(requestAuthorized("https://trusted.example:9443", "10.0.0.2", 18088, allowed)).toBeFalse();
  expect(requestAuthorized("https://trusted.example:9443", "127.0.0.1", 18088, allowed)).toBeTrue();
});

test("API preflight denies DNS rebinding and remote peers, with exact allowlist CORS", async () => {
  const hostile = await fetchHandler(
    request("/api/entities", { origin: "http://evil.example:18088" }),
    fakeServer("127.0.0.1"),
  );
  expect(hostile.status).toBe(403);
  expect(hostile.headers.get("access-control-allow-origin")).toBeNull();

  const forgedLocal = await fetchHandler(
    request("/api/entities", { origin: "http://localhost:18088" }),
    fakeServer("10.0.0.2"),
  );
  expect(forgedLocal.status).toBe(403);

  const remoteNoOrigin = await fetchHandler(
    request("/api/entities"),
    fakeServer("10.0.0.2"),
  );
  expect(remoteNoOrigin.status).toBe(403);

  const local = await fetchHandler(
    request("/api/entities", { origin: "http://localhost:18088" }),
    fakeServer("127.0.0.1"),
  );
  expect(local.status).toBe(204);
  expect(local.headers.get("access-control-allow-origin")).toBeNull();

  const explicitlyAllowed = await fetchHandler(
    request("/api/entities", { origin: "https://trusted.example:9443" }),
    fakeServer("127.0.0.1"),
  );
  expect(explicitlyAllowed.status).toBe(204);
  expect(explicitlyAllowed.headers.get("access-control-allow-origin")).toBe(
    "https://trusted.example:9443",
  );
  expect(explicitlyAllowed.headers.get("vary")).toBe("Origin");
});

test("WebSocket upgrades use the same peer and Origin boundary", async () => {
  let upgrades = 0;
  const acceptUpgrade = () => {
    upgrades += 1;
    return true;
  };

  const accepted = await fetchHandler(
    request("/api/live", { method: "GET", origin: "http://127.0.0.1:18088" }),
    fakeServer("127.0.0.1", acceptUpgrade),
  );
  expect(accepted).toBeUndefined();
  expect(upgrades).toBe(1);

  const hostile = await fetchHandler(
    request("/live", { method: "GET", origin: "http://evil.example:18088" }),
    fakeServer("127.0.0.1", acceptUpgrade),
  );
  expect(hostile.status).toBe(403);
  expect(upgrades).toBe(1);

  const remoteMissingOrigin = await fetchHandler(
    request("/live", { method: "GET" }),
    fakeServer("10.0.0.2", acceptUpgrade),
  );
  expect(remoteMissingOrigin.status).toBe(403);
  expect(upgrades).toBe(1);

  const allowedRemote = await fetchHandler(
    request("/live", { method: "GET", origin: "https://trusted.example:9443" }),
    fakeServer("10.0.0.2", acceptUpgrade),
  );
  expect(allowedRemote.status).toBe(403);
  expect(upgrades).toBe(1);
});

test("static serving accepts only the closed asset manifest", async () => {
  const assets = [
    "/assets/css/app.css",
    "/favicon.ico",
    "/js/board-write.js",
    "/js/cytoscape.min.js",
    "/js/north-agents.js",
    "/js/north-app.js",
    "/js/north-arena.js",
    "/js/north-board.js",
    "/js/north-list.js",
    "/js/north-ui.js",
    "/js/wake-mounts.js",
    "/robots.txt",
  ];
  for (const assetPath of assets) {
    expect(staticAssetRelativePath(assetPath)).toBe(assetPath.slice(1));
    const response = await fetchHandler(
      request(assetPath, { method: "GET" }),
      fakeServer("127.0.0.1"),
    );
    expect(response.status).toBe(200);
  }

  for (const hostile of [
    "/../README.md",
    "/%2e%2e/README.md",
    "/assets/css/%2e%2e/%2e%2e/README.md",
    "/assets/css/..%2f..%2fREADME.md",
    "/assets/css/..\\..\\README.md",
    "//etc/passwd",
  ]) {
    expect(staticAssetRelativePath(hostile)).toBeNull();
    const response = await fetchHandler(
      request(hostile, { method: "GET" }),
      fakeServer("127.0.0.1"),
    );
    expect(response.status).toBe(404);
  }
});

test("POST bodies are strict JSON objects with an explicit wire-byte cap", async () => {
  const parsed = await readJsonBody(
    request("/api/assert", {
      body: JSON.stringify({ e: "@safe", p: "title", r: "safe" }),
      method: "POST",
    }),
  );
  expect(parsed).toEqual({ e: "@safe", p: "title", r: "safe" });

  for (const malformed of ["", "{", "null", "[]", "\"string\""]) {
    const response = await fetchHandler(
      request("/api/assert", { body: malformed, method: "POST" }),
      fakeServer("127.0.0.1"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON request body" });
  }

  const oversized = await fetchHandler(
    request("/api/assert", {
      body: JSON.stringify({ r: "x".repeat(65536) }),
      method: "POST",
    }),
    fakeServer("127.0.0.1"),
  );
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({
    error: "request body exceeds 65536 bytes",
  });

  const multibyteOversized = await fetchHandler(
    request("/api/assert", {
      body: JSON.stringify({ r: "界".repeat(22000) }),
      method: "POST",
    }),
    fakeServer("127.0.0.1"),
  );
  expect(multibyteOversized.status).toBe(413);

  const invalidUtf8 = await fetchHandler(
    new Request("http://127.0.0.1:18088/api/assert", {
      body: new Uint8Array([0xc3, 0x28]),
      method: "POST",
    }),
    fakeServer("127.0.0.1"),
  );
  expect(invalidUtf8.status).toBe(400);
});

test("server startup passes the loopback bind explicitly to Bun", () => {
  let options;
  let stops = 0;
  Bun.serve = (provided) => {
    options = provided;
    return {
      stop() {
        stops += 1;
      },
    };
  };
  const server = startServer();
  expect(options.hostname).toBe("127.0.0.1");
  expect(options.port).toBe(18088);
  server.stop();
  expect(stops).toBe(1);
});

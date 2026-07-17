import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  MAX_READONLY_COMMAND_BYTES, preflightReadonlyShell, readonlyShellSeccompProgram,
  runReadonlyShell,
} from "../src/readonly-shell";

const repo = resolve(import.meta.dir, "../..");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function checkout(): string {
  const path = mkdtempSync(join(repo, ".north-readonly-test-"));
  temporary.push(path);
  return path;
}

test("read-only shell preflight proves checkout denial and ephemeral tmp writes", async () => {
  const cwd = checkout();
  expect(preflightReadonlyShell(cwd).cwd).toBe(cwd);
  const forbidden = join(cwd, "must-not-land");
  const result = await runReadonlyShell(
    "printf read-ok; printf tmp-ok >/tmp/probe; "
      + "if printf forbidden > must-not-land 2>/dev/null; then exit 42; fi; cat /tmp/probe",
    cwd,
    5_000,
  );
  expect(result).toMatchObject({
    ok: true,
    exitCode: 0,
    timedOut: false,
    outputLimitExceeded: false,
    stdout: "read-oktmp-ok",
  });
  expect(existsSync(forbidden)).toBe(false);
});

test("read-only shell preserves canonical home reads while denying home writes", async () => {
  const markerName = `.north-readonly-home-${randomUUID()}`;
  const marker = join(process.env.HOME!, markerName);
  const result = await runReadonlyShell(
    `test "$HOME" = ${JSON.stringify(process.env.HOME!)}; test -d ~; `
      + `if printf forbidden > ~/${markerName} 2>/dev/null; then exit 42; `
      + "else printf home-readonly; fi",
    checkout(),
    5_000,
  );
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("home-readonly");
  expect(existsSync(marker)).toBe(false);
});

test("seccomp program denies native socket, io_uring setup, and the x32 range", () => {
  const program = readonlyShellSeccompProgram();
  const instructions = Array.from({ length: program.length / 8 }, (_, index) => {
    const offset = index * 8;
    return [
      program.readUInt16LE(offset),
      program.readUInt8(offset + 2),
      program.readUInt8(offset + 3),
      program.readUInt32LE(offset + 4),
    ];
  });
  if (process.arch === "x64") {
    expect(instructions).toEqual([
      [0x20, 0, 0, 4],
      [0x15, 1, 0, 0xc000003e],
      [0x06, 0, 0, 0x80000000],
      [0x20, 0, 0, 0],
      [0x35, 0, 1, 0x40000000],
      [0x06, 0, 0, 0x80000000],
      [0x15, 1, 0, 41],
      [0x15, 0, 1, 425],
      [0x06, 0, 0, 0x00050001],
      [0x06, 0, 0, 0x7fff0000],
    ]);
  } else if (process.arch === "arm64") {
    expect(instructions).toEqual([
      [0x20, 0, 0, 4],
      [0x15, 1, 0, 0xc00000b7],
      [0x06, 0, 0, 0x80000000],
      [0x20, 0, 0, 0],
      [0x15, 1, 0, 198],
      [0x15, 0, 1, 425],
      [0x06, 0, 0, 0x00050001],
      [0x06, 0, 0, 0x7fff0000],
    ]);
  }
});

test("read-only shell has no usable network namespace", async () => {
  const result = await runReadonlyShell(
    "if exec 3<>/dev/tcp/127.0.0.1/7977 2>/dev/null; then exit 42; "
      + "else printf network-denied; fi",
    checkout(),
    5_000,
  );
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("network-denied");
});

test("read-only shell denies io_uring setup", async () => {
  const result = await runReadonlyShell(
    "perl -e 'my $r = syscall(425, 0, 0); "
      + "if ($r == -1 && $! == 1) { print \"io-uring-denied\"; exit 0 } exit 42'",
    checkout(),
    5_000,
  );
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("io-uring-denied");
});

test("read-only shell cannot create a replacement user namespace", async () => {
  const result = await runReadonlyShell(
    "if unshare --user --map-root-user true 2>/dev/null; then exit 42; "
      + "else printf userns-denied; fi",
    checkout(),
    5_000,
  );
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("userns-denied");
});

test("read-only shell hides host D-Bus and Podman control sockets", async () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const result = await runReadonlyShell(
    `test ! -e /run/user/${uid}/bus && printf dbus-hidden; `
      + "test ! -e /run/podman/podman.sock && printf podman-hidden",
    checkout(),
    5_000,
  );
  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("dbus-hiddenpodman-hidden");
});

test("read-only shell cannot connect to a visible host Unix socket outside /run", async () => {
  const cwd = checkout();
  const socketPath = join(cwd, "host-control.sock");
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  try {
    const result = await runReadonlyShell(
      `if curl --silent --show-error --max-time 1 --unix-socket ${JSON.stringify(socketPath)} `
        + "http://localhost/_ping >/dev/null 2>&1; then exit 42; else printf socket-denied; fi",
      cwd,
      5_000,
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("socket-denied");
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("timeout kills the entire sandbox process group, including a background child", async () => {
  const marker = `north-ro-child-${randomUUID()}`;
  const result = await runReadonlyShell(
    `bash --noprofile --norc -c 'sleep 60; wait' ${marker} & wait`,
    checkout(),
    150,
  );
  expect(result.timedOut).toBe(true);
  expect(result.ok).toBe(false);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const processes = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  expect(processes.split("\n").some((line) => line.includes(marker))).toBe(false);
});

test("combined output is bounded and overflow terminates the sandbox", async () => {
  const result = await runReadonlyShell(
    "yes x | head -c 1100000",
    checkout(),
    5_000,
  );
  expect(result.outputLimitExceeded).toBe(true);
  expect(result.ok).toBe(false);
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr))
    .toBeLessThanOrEqual(1_048_576);
});

test("oversized commands and non-finite timeouts fail before sandbox spawn", async () => {
  const cwd = checkout();
  const probe = join(cwd, "must-not-run");
  const oversized = `: > ${JSON.stringify(probe)}; #${"x".repeat(MAX_READONLY_COMMAND_BYTES)}`;
  await expect(runReadonlyShell(oversized, cwd, 5_000))
    .rejects.toThrow("exceeds 65536 UTF-8 bytes");
  await expect(runReadonlyShell(`: > ${JSON.stringify(probe)}`, cwd, Number.NaN))
    .rejects.toThrow("timeout must be finite");
  await expect(runReadonlyShell(`: > ${JSON.stringify(probe)}`, cwd, Number.POSITIVE_INFINITY))
    .rejects.toThrow("timeout must be finite");
  expect(existsSync(probe)).toBe(false);
});

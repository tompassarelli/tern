import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const fixture = resolve(import.meta.dir, "fixtures", "live-feed-process-fixture.ts");
const modes = [
  "normal",
  "timeout",
  "provider_failure",
  "cancellation",
  "escalation",
  "parent_disconnect",
] as const;

for (const mode of modes) {
  test(`real Bun wrapper settles and reaps its live-feed bb on ${mode}`, async () => {
    const child = spawn(process.execPath, [fixture, mode], {
      cwd: resolve(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let parentSignalSent = false;
    child.stdout!.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (
        mode === "parent_disconnect"
        && !parentSignalSent
        && stdout.includes('"type":"started"')
      ) {
        parentSignalSent = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `${mode} fixture did not exit\nstdout=${stdout}\nstderr=${stderr}`,
          ));
        }, 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(exit).toEqual({ code: 0, signal: null });
    const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "started", mode });
    expect(frames[1]).toMatchObject({
      type: "terminal",
      mode,
      outcome: mode,
      digest: `preserved:${mode}`,
      sameSettlement: true,
      closeEvents: 1,
      childAliveAfterSettlement: false,
    });
    if (mode === "timeout") {
      expect(frames[1].readinessError).toBe("NORTH_LIVE_FEED_STARTUP_TIMEOUT");
    }
    if (mode === "escalation") {
      expect(frames[1].signals).toEqual(["SIGTERM", "SIGKILL"]);
    } else {
      expect(frames[1].signals).toEqual(["SIGTERM"]);
    }
    expect(() => process.kill(frames[0].childPid, 0)).toThrow();
  });
}

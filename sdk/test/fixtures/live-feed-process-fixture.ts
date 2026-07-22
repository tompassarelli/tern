import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { subscribeFeed } from "../../src/coordination";
import { trustedNorthBabashkaExecutable } from "../../src/trusted-runtime";

const modes = [
  "normal",
  "timeout",
  "provider_failure",
  "cancellation",
  "escalation",
  "parent_disconnect",
] as const;
type Mode = typeof modes[number];

const requestedMode = process.argv[2];
if (!modes.includes(requestedMode as Mode))
  throw new Error(`unknown live-feed process fixture mode: ${requestedMode}`);
const mode = requestedMode as Mode;
const recipient = `live-feed-process-${mode}`;
const readyFrame = JSON.stringify({
  protocol: "north-live-feed-v1",
  type: "ready",
  recipient,
  subscribed: 0,
});

let releaseParentDisconnect!: () => void;
const parentDisconnected = new Promise<void>((resolve) => {
  releaseParentDisconnect = resolve;
});
if (mode === "parent_disconnect")
  process.once("SIGTERM", releaseParentDisconnect);

let childPid: number | undefined;
let closeEvents = 0;
const signals: string[] = [];
const subscription = subscribeFeed(recipient, () => true, {
  bbExecutable: trustedNorthBabashkaExecutable(),
  spawn: ((command: string, _args: string[], options: unknown) => {
    const emitsReady = mode !== "timeout";
    const expression = emitsReady
      ? `(do (println ${JSON.stringify(readyFrame)}) (flush) (Thread/sleep 600000))`
      : "(Thread/sleep 600000)";
    const child = nodeSpawn(command, ["-e", expression], {
      ...(options as Parameters<typeof nodeSpawn>[2]),
    });
    childPid = child.pid;
    child.once("close", () => { closeEvents++; });
    const kill = child.kill.bind(child);
    child.kill = ((signal?: Parameters<ChildProcess["kill"]>[0]) => {
      signals.push(String(signal));
      if (mode === "escalation" && signal === "SIGTERM") return true;
      return kill(signal);
    }) as ChildProcess["kill"];
    return child;
  }) as typeof nodeSpawn,
  readyTimeoutMs: 1_000,
  startupTimeoutMs: mode === "timeout" ? 50 : 2_000,
  stopKillMs: mode === "escalation" ? 25 : 100,
  stopReapMs: 1_000,
});

if (childPid === undefined) throw new Error("live-feed child PID unavailable");
console.log(JSON.stringify({ type: "started", mode, childPid }));

let outcome: string = mode;
let readinessError: string | undefined;
if (mode === "timeout") {
  const error = await subscription.ready.catch((cause) => cause);
  readinessError = error?.code;
} else {
  await subscription.ready;
}
if (mode === "provider_failure") {
  try {
    throw new Error("fixture provider failed");
  } catch {
    outcome = "provider_failure";
  }
}
if (mode === "parent_disconnect") await parentDisconnected;

const firstSettlement = subscription();
const secondSettlement = subscription();
const sameSettlement = firstSettlement === secondSettlement;
await Promise.all([firstSettlement, secondSettlement]);

let childAliveAfterSettlement = true;
try { process.kill(childPid, 0); }
catch { childAliveAfterSettlement = false; }
console.log(JSON.stringify({
  type: "terminal",
  mode,
  outcome,
  digest: `preserved:${mode}`,
  readinessError,
  sameSettlement,
  closeEvents,
  signals,
  childAliveAfterSettlement,
}));

import { spawn } from "node:child_process";

// Bun can race teardown of a freshly created extra-stdio socket when the
// nested process rejects before attachment finishes. Keep the test process's
// fd 3 attached to this wrapper for the complete supervisor lifetime, and give
// the supervisor that already-open descriptor instead of asking Bun to create
// another status pipe. This changes only the test transport, never production.
const child = spawn(process.execPath, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe", 3],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});

const outcome = await new Promise((resolve) => {
  child.once("error", () => resolve({ code: 127, signal: null }));
  child.once("close", (code, signal) => resolve({ code, signal }));
});

process.stdin.unpipe(child.stdin);
process.stdin.pause();
process.exitCode = outcome.code ?? (
  outcome.signal === "SIGTERM" ? 143
    : outcome.signal === "SIGKILL" ? 137
      : outcome.signal === "SIGINT" ? 130
        : 1
);

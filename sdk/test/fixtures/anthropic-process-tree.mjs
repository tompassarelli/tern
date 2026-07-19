import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2] ?? "hold";

if (mode === "grandchild") {
  if (process.env.NORTH_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  const descendant = spawn(process.execPath, [self, "grandchild"], {
    env: process.env,
    stdio: "ignore",
  });
  if (!descendant.pid) throw new Error("fixture descendant did not start");
  writeFileSync(process.env.NORTH_PID_FILE, JSON.stringify({
    leader: process.pid,
    descendant: descendant.pid,
    pgid: process.pid,
  }));
  if (mode === "natural") setImmediate(() => process.exit(0));
  else {
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    setInterval(() => {}, 1_000);
  }
}

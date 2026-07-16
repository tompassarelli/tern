import { ingestClaudeStatusline } from "./claude-statusline-observation";

// This command is fed by an interactive statusline, so malformed input and
// unavailable state are telemetry loss, never user-visible statusline errors.
if (process.argv[2] === "claude-statusline") {
  try {
    await ingestClaudeStatusline(JSON.parse(await Bun.stdin.text()));
  } catch {
    // Deliberately silent and successful: the caller is a best-effort observer.
  }
}

import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";

// Resolved at CONSTRUCTION (not module load) so a NORTH_STREAM_DIR override applies
// regardless of import order — the same lesson identity.ts/death.ts encode for NORTH_BIN.
// In production the value is fixed for the process; only tests that redirect it mid-run
// (each to its own temp dir) rely on the lazy read, which keeps them isolation-safe.
const streamDir = () =>
  process.env.NORTH_STREAM_DIR ??
  join(process.env.HOME ?? "", "code/agent-data");

// Write SDK messages to .stream.jsonl in the same format the web client tails.
// This bridges SDK dispatch into the existing web client without changing the bridge.
export class StreamWriter {
  private path: string;

  constructor(agentId: string) {
    this.path = join(streamDir(), `agent-${agentId}.stream.jsonl`);
    writeFileSync(this.path, "");
  }

  write(event: any) {
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }

  // Normalize an SDK message into the stream format the web client expects.
  writeSDKMessage(message: any) {
    if (message.type === "assistant" && message.message?.content) {
      this.write({
        type: "assistant",
        content: message.message.content,
        ...(message.parent_tool_use_id
          ? { parent_tool_use_id: message.parent_tool_use_id }
          : {}),
      });
    } else if (message.type === "result") {
      this.write({ type: "result", result: message.result ?? "" });
    } else if (message.type === "system") {
      this.write({
        type: "system",
        subtype: message.subtype ?? "",
        ...(message.data ? { data: message.data } : {}),
      });
    }
  }
}

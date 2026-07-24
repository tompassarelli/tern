const RESULT_SUBTYPES = new Set([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
const ASSISTANT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
]);
const STREAM_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function onlyRecordKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function compactBoundaryIsProgress(message: Record<string, unknown>): boolean {
  const metadata = objectRecord(message.compact_metadata);
  if (!metadata || !onlyRecordKeys(metadata, [
    "trigger", "pre_tokens", "post_tokens", "duration_ms",
    "preserved_segment", "preserved_messages",
  ])) return false;
  if (metadata.trigger !== "manual" && metadata.trigger !== "auto") return false;
  if (!Number.isSafeInteger(metadata.pre_tokens) || (metadata.pre_tokens as number) < 0) return false;
  for (const key of ["post_tokens", "duration_ms"] as const) {
    if (metadata[key] !== undefined
        && (!Number.isSafeInteger(metadata[key]) || (metadata[key] as number) < 0)) return false;
  }
  const segment = metadata.preserved_segment;
  if (segment !== undefined) {
    const record = objectRecord(segment);
    if (!record || !onlyRecordKeys(record, ["head_uuid", "anchor_uuid", "tail_uuid"])
        || !nonemptyString(record.head_uuid) || !nonemptyString(record.anchor_uuid)
        || !nonemptyString(record.tail_uuid)) return false;
  }
  const preserved = metadata.preserved_messages;
  if (preserved !== undefined) {
    const record = objectRecord(preserved);
    if (!record || !onlyRecordKeys(record, ["anchor_uuid", "uuids"])
        || !nonemptyString(record.anchor_uuid) || !Array.isArray(record.uuids)
        || !record.uuids.every(nonemptyString)) return false;
  }
  return true;
}

function assistantBlockIsProgress(value: unknown): boolean {
  const block = objectRecord(value);
  if (!block) return false;
  if (block.type === "text") return nonemptyString(block.text);
  if (block.type === "thinking") return nonemptyString(block.thinking);
  if (block.type === "redacted_thinking") return nonemptyString(block.data);
  if (block.type === "tool_use" || block.type === "server_tool_use")
    return nonemptyString(block.id) && nonemptyString(block.name) && objectRecord(block.input) !== undefined;
  return typeof block.type === "string" && ASSISTANT_BLOCK_TYPES.has(block.type)
    && (nonemptyString(block.tool_use_id) || block.content !== undefined);
}

/**
 * Classify the normalized cross-provider outer stream conservatively. Provider
 * status, rate-limit, retry, session, task/background, and arbitrary messages
 * still flow to consumers, but cannot manufacture execution liveness.
 */
export function isOuterExecutionActivity(value: unknown): boolean {
  const message = objectRecord(value);
  if (!message) return false;
  if (message.type === "result")
    return typeof message.subtype === "string" && RESULT_SUBTYPES.has(message.subtype);
  if (message.type === "assistant") {
    if (message.error !== undefined) return false;
    const envelope = objectRecord(message.message);
    if (!envelope || !Array.isArray(envelope.content)) return false;
    return envelope.content.some(assistantBlockIsProgress);
  }
  if (message.type === "user") {
    const envelope = objectRecord(message.message);
    return Boolean(envelope && Array.isArray(envelope.content)
      && envelope.content.some((block) => {
        const result = objectRecord(block);
        return result?.type === "tool_result" && nonemptyString(result.tool_use_id);
      }));
  }
  if (message.type === "stream_event") {
    const event = objectRecord(message.event);
    return typeof event?.type === "string" && STREAM_EVENT_TYPES.has(event.type);
  }
  if (message.type === "tool_progress") {
    return message.task_id === undefined
      && nonemptyString(message.tool_use_id)
      && nonemptyString(message.tool_name)
      && (message.parent_tool_use_id === null || nonemptyString(message.parent_tool_use_id))
      && typeof message.elapsed_time_seconds === "number"
      && Number.isFinite(message.elapsed_time_seconds)
      && message.elapsed_time_seconds >= 0;
  }
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    return Number.isSafeInteger(message.estimated_tokens)
      && (message.estimated_tokens as number) >= 0
      && Number.isSafeInteger(message.estimated_tokens_delta)
      && (message.estimated_tokens_delta as number) > 0;
  }
  if (message.type === "system" && message.subtype === "compact_boundary")
    return compactBoundaryIsProgress(message);
  return false;
}

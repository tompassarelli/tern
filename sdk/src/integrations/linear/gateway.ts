import type {
  McpAccess, McpBroker, McpBrokerOpenOptions, McpBrokerSession, McpServerInventory,
  McpToolDefinition, McpToolResult, ModelFreeTransportReceipt,
} from "./mcp-broker";
import { normalizeLinearConnector } from "./normalize";
import { normalizeLinearRemoteKey } from "./normalize";

export const LINEAR_READ_TOOL = "get_issue";
export const LINEAR_LIST_ISSUES_TOOL = "list_issues";
export const LINEAR_WRITE_TOOL = "save_issue";
export const LINEAR_LIST_COMMENTS_TOOL = "list_comments";
export const LINEAR_SAVE_COMMENT_TOOL = "save_comment";

const LINEAR_TOOL_ACCESS: Readonly<Record<string, McpAccess>> = Object.freeze({
  [LINEAR_READ_TOOL]: "read",
  [LINEAR_LIST_ISSUES_TOOL]: "read",
  [LINEAR_LIST_COMMENTS_TOOL]: "read",
  [LINEAR_WRITE_TOOL]: "write",
  [LINEAR_SAVE_COMMENT_TOOL]: "write",
});

export type LinearCallEnvelope =
  | { access: "read"; method: typeof LINEAR_READ_TOOL; arguments: Record<string, unknown> }
  | { access: "read"; method: typeof LINEAR_LIST_ISSUES_TOOL; arguments: Record<string, unknown> }
  | { access: "read"; method: typeof LINEAR_LIST_COMMENTS_TOOL; arguments: Record<string, unknown> }
  | { access: "write"; method: typeof LINEAR_WRITE_TOOL; arguments: Record<string, unknown> }
  | { access: "write"; method: typeof LINEAR_SAVE_COMMENT_TOOL; arguments: Record<string, unknown> };

export interface LinearGatewayOptions extends McpBrokerOpenOptions {
  server?: string;
}

export interface LinearGateway {
  readonly server: string;
  call(envelope: LinearCallEnvelope): Promise<unknown>;
  readIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  listIssues(arguments_: Record<string, unknown>): Promise<unknown>;
  writeIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  listComments(arguments_: Record<string, unknown>): Promise<unknown>;
  writeComment(arguments_: Record<string, unknown>): Promise<unknown>;
  transportReceipt(): ModelFreeTransportReceipt;
  close(): Promise<void>;
}

export type LinearGatewayErrorKind = "not-found";

export class LinearGatewayError extends Error {
  constructor(
    readonly kind: LinearGatewayErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LinearGatewayError";
  }
}

type Schema = Record<string, unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaObject(tool: McpToolDefinition): Schema {
  if (!record(tool.inputSchema) || tool.inputSchema.type !== "object" || !record(tool.inputSchema.properties))
    throw new Error(`Linear MCP tool ${tool.name} has an incompatible input schema`);
  return tool.inputSchema;
}

function propertyAllowsString(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "string") return true;
  return Array.isArray(value.anyOf) && value.anyOf.some(propertyAllowsString);
}

function gateLinearCapabilities(server: McpServerInventory): void {
  normalizeLinearConnector(server.name);
  if (server.authStatus !== "oAuth")
    throw new Error(`Linear MCP server ${server.name} is not OAuth-ready (auth: ${server.authStatus})`);
  const read = server.tools[LINEAR_READ_TOOL];
  const listIssues = server.tools[LINEAR_LIST_ISSUES_TOOL];
  const write = server.tools[LINEAR_WRITE_TOOL];
  const listComments = server.tools[LINEAR_LIST_COMMENTS_TOOL];
  const saveComment = server.tools[LINEAR_SAVE_COMMENT_TOOL];
  if (!read || !listIssues || !write || !listComments || !saveComment)
    throw new Error(`Linear MCP server ${server.name} lacks list/get/save issue and comment sync capabilities`);

  const readSchema = schemaObject(read);
  const readProperties = readSchema.properties as Record<string, unknown>;
  if (!Array.isArray(readSchema.required) || !readSchema.required.includes("id") || !propertyAllowsString(readProperties.id))
    throw new Error(`Linear MCP tool ${LINEAR_READ_TOOL} no longer requires a string id`);
  if (read.annotations?.readOnlyHint !== true || read.annotations?.destructiveHint !== false
      || read.annotations?.idempotentHint !== true || read.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_READ_TOOL} lacks safe read annotations`);

  const listIssuesSchema = schemaObject(listIssues);
  const listIssuesProperties = listIssuesSchema.properties as Record<string, unknown>;
  if (!propertyAllowsString(listIssuesProperties.query))
    throw new Error(`Linear MCP tool ${LINEAR_LIST_ISSUES_TOOL} lacks expected string field query`);
  if (listIssues.annotations?.readOnlyHint !== true || listIssues.annotations?.destructiveHint !== false
      || listIssues.annotations?.idempotentHint !== true || listIssues.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_LIST_ISSUES_TOOL} lacks safe read annotations`);

  const writeSchema = schemaObject(write);
  const writeProperties = writeSchema.properties as Record<string, unknown>;
  for (const property of ["id", "title", "description"])
    if (!propertyAllowsString(writeProperties[property]))
      throw new Error(`Linear MCP tool ${LINEAR_WRITE_TOOL} lacks expected string field ${property}`);
  if (write.annotations?.readOnlyHint !== false || write.annotations?.destructiveHint !== true
      || write.annotations?.idempotentHint !== false || write.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_WRITE_TOOL} lacks explicit write annotations`);

  const commentsSchema = schemaObject(listComments);
  const commentsProperties = commentsSchema.properties as Record<string, unknown>;
  if (!propertyAllowsString(commentsProperties.issueId))
    throw new Error(`Linear MCP tool ${LINEAR_LIST_COMMENTS_TOOL} lacks expected string field issueId`);
  if (listComments.annotations?.readOnlyHint !== true || listComments.annotations?.destructiveHint !== false
      || listComments.annotations?.idempotentHint !== true || listComments.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_LIST_COMMENTS_TOOL} lacks safe read annotations`);

  const commentWriteSchema = schemaObject(saveComment);
  const commentWriteProperties = commentWriteSchema.properties as Record<string, unknown>;
  for (const property of ["id", "issueId", "body"])
    if (!propertyAllowsString(commentWriteProperties[property]))
      throw new Error(`Linear MCP tool ${LINEAR_SAVE_COMMENT_TOOL} lacks expected string field ${property}`);
  if (!Array.isArray(commentWriteSchema.required) || !commentWriteSchema.required.includes("body"))
    throw new Error(`Linear MCP tool ${LINEAR_SAVE_COMMENT_TOOL} no longer requires body`);
  if (saveComment.annotations?.readOnlyHint !== false || saveComment.annotations?.destructiveHint !== true
      || saveComment.annotations?.idempotentHint !== false || saveComment.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_SAVE_COMMENT_TOOL} lacks explicit write annotations`);
}

function supportsLinear(server: McpServerInventory): boolean {
  return Boolean(server.tools[LINEAR_READ_TOOL] && server.tools[LINEAR_LIST_ISSUES_TOOL] && server.tools[LINEAR_WRITE_TOOL]
    && server.tools[LINEAR_LIST_COMMENTS_TOOL] && server.tools[LINEAR_SAVE_COMMENT_TOOL]);
}

export function discoverLinearServer(servers: readonly McpServerInventory[], explicit?: string): McpServerInventory {
  if (explicit) {
    const canonicalExplicit = normalizeLinearConnector(explicit);
    const matches = servers.filter(({ name }) => name === canonicalExplicit);
    if (matches.length !== 1) throw new Error(`Configured Linear MCP server ${canonicalExplicit} was not found exactly once`);
    gateLinearCapabilities(matches[0]);
    return matches[0];
  }
  const candidates = servers.filter(supportsLinear);
  for (const candidate of candidates) normalizeLinearConnector(candidate.name);
  if (candidates.length !== 1) {
    const names = candidates.map(({ name }) => name).sort().join(", ") || "none";
    throw new Error(`Expected exactly one Linear MCP server with issue/comment sync capabilities; found ${candidates.length} (${names})`);
  }
  gateLinearCapabilities(candidates[0]);
  return candidates[0];
}

function schemaTypeMatches(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((entry) => schemaTypeMatches(entry, value));
  if (type === "null") return value === null;
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return record(value);
  return false;
}

function validateValue(schema: unknown, value: unknown, path: string): void {
  if (schema === true) return;
  if (!record(schema)) throw new Error(`Unsupported Linear MCP schema at ${path}`);
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((candidate) => {
      try { validateValue(candidate, value, path); return true; }
      catch { return false; }
    });
    if (!valid) throw new Error(`Linear MCP argument ${path} does not match its schema`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value)))
    throw new Error(`Linear MCP argument ${path} is outside its allowed values`);
  if (schema.type !== undefined && !schemaTypeMatches(schema.type, value))
    throw new Error(`Linear MCP argument ${path} has the wrong type`);
  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`));
  if (record(value) && schema.type === "object") {
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required)
      if (typeof key === "string" && !(key in value)) throw new Error(`Linear MCP argument ${path}.${key} is required`);
    for (const [key, entry] of Object.entries(value)) {
      if (key in properties) validateValue(properties[key], entry, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Linear MCP argument ${path}.${key} is not accepted by the live schema`);
      else if (record(schema.additionalProperties) || schema.additionalProperties === true)
        validateValue(schema.additionalProperties, entry, `${path}.${key}`);
    }
  }
}

function validateArguments(tool: McpToolDefinition, arguments_: Record<string, unknown>): void {
  validateValue(schemaObject(tool), arguments_, tool.name);
}

function textContent(result: McpToolResult): string[] {
  return result.content.flatMap((entry) => {
    if (!record(entry) || entry.type !== "text" || typeof entry.text !== "string") return [];
    return [entry.text];
  });
}

/** Normalize MCP output mechanically; no model is involved. */
function observedGetIssueNotFound(result: McpToolResult): boolean {
  if (result.structuredContent !== undefined || result.content.length !== 1) return false;
  const [entry] = result.content;
  if (!record(entry) || entry.type !== "text" || typeof entry.text !== "string"
      || Buffer.byteLength(entry.text, "utf8") > 4096)
    return false;
  let parsed: unknown;
  try { parsed = JSON.parse(entry.text); }
  catch { return false; }
  // `invalid_request` plus HTTP 400 is the connector's generic validation
  // class. Its exact observed missing-Issue message is therefore load-bearing:
  // wording drift must fail closed instead of authorizing backlink fanout for
  // an unrelated validation or policy error.
  if (!record(parsed)
      || Object.keys(parsed).sort().join(",") !== "error,message,requestId,status"
      || parsed.error !== "invalid_request"
      || parsed.status !== 400
      || parsed.message !== "Could not find referenced Issue."
      || typeof parsed.requestId !== "string"
      || !parsed.requestId.trim()
      || parsed.requestId !== parsed.requestId.trim()
      || Buffer.byteLength(parsed.requestId, "utf8") > 256)
    return false;
  return true;
}

function structuredGetIssueNotFound(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "error")
      || !record(value.error))
    return false;
  const error = value.error;
  return Object.keys(error).sort().join(",") === "code,message"
    && error.code === "NOT_FOUND"
    && typeof error.message === "string"
    && Buffer.byteLength(error.message, "utf8") <= 4096;
}

export function normalizeLinearResult(
  result: McpToolResult,
  method?: string,
): unknown {
  const text = textContent(result);
  if (result.isError) {
    if (method === LINEAR_READ_TOOL
        && (structuredGetIssueNotFound(result.structuredContent)
          || observedGetIssueNotFound(result)))
      throw new LinearGatewayError("not-found", "Linear MCP issue was not found");
    throw new Error("Linear MCP tool failed");
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!text.length) throw new Error("Linear MCP tool returned neither structuredContent nor JSON text");
  try { return JSON.parse(text.join("\n")); }
  catch { throw new Error("Linear MCP tool returned non-JSON text without structuredContent"); }
}

class ConnectedLinearGateway implements LinearGateway {
  readonly server: string;
  constructor(
    private session: McpBrokerSession,
    private inventory: McpServerInventory,
  ) { this.server = inventory.name; }

  async call(envelope: LinearCallEnvelope): Promise<unknown> {
    const method = (envelope as { method?: unknown }).method;
    if (typeof method !== "string" || !Object.hasOwn(LINEAR_TOOL_ACCESS, method)) {
      const received = typeof method === "string" ? method : `<${typeof method}>`;
      throw new Error(`Linear MCP method ${received} is outside North's runtime allowlist`);
    }
    const expected = LINEAR_TOOL_ACCESS[method]!;
    if (envelope.access !== expected)
      throw new Error(`Linear MCP ${method} must be called through explicit ${expected} access`);
    const tool = this.inventory.tools[method];
    if (!tool) throw new Error(`Linear MCP method ${method} is not available`);
    validateArguments(tool, envelope.arguments);
    if (method === LINEAR_READ_TOOL)
      normalizeLinearRemoteKey(envelope.arguments.id as string);
    return normalizeLinearResult(await this.session.callTool({
      access: envelope.access,
      server: this.server,
      tool: method,
      arguments: envelope.arguments,
    }), method);
  }

  readIssue(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "read", method: LINEAR_READ_TOOL, arguments: arguments_ });
  }

  listIssues(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "read", method: LINEAR_LIST_ISSUES_TOOL, arguments: arguments_ });
  }

  writeIssue(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "write", method: LINEAR_WRITE_TOOL, arguments: arguments_ });
  }

  listComments(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "read", method: LINEAR_LIST_COMMENTS_TOOL, arguments: arguments_ });
  }

  writeComment(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "write", method: LINEAR_SAVE_COMMENT_TOOL, arguments: arguments_ });
  }

  transportReceipt(): ModelFreeTransportReceipt {
    return { ...this.session.transportReceipt(), linearServer: this.server };
  }

  close(): Promise<void> { return this.session.close(); }
}

export async function openLinearGateway(broker: McpBroker, options: LinearGatewayOptions = {}): Promise<LinearGateway> {
  const session = await broker.open({ cwd: options.cwd });
  try {
    const server = discoverLinearServer(await session.listServers(), options.server);
    return new ConnectedLinearGateway(session, server);
  } catch (error) {
    try { await session.close(); }
    catch { /* preserve the capability/discovery failure */ }
    throw error;
  }
}

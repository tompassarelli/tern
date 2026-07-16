import type {
  McpBroker, McpBrokerOpenOptions, McpBrokerSession, McpServerInventory,
  McpToolDefinition, McpToolResult,
} from "./mcp-broker";

export const LINEAR_READ_TOOL = "get_issue";
export const LINEAR_WRITE_TOOL = "save_issue";

export type LinearCallEnvelope =
  | { access: "read"; method: typeof LINEAR_READ_TOOL; arguments: Record<string, unknown> }
  | { access: "write"; method: typeof LINEAR_WRITE_TOOL; arguments: Record<string, unknown> };

export interface LinearGatewayOptions extends McpBrokerOpenOptions {
  server?: string;
}

export interface LinearGateway {
  readonly server: string;
  call(envelope: LinearCallEnvelope): Promise<unknown>;
  readIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  writeIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
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
  if (server.authStatus !== "oAuth")
    throw new Error(`Linear MCP server ${server.name} is not OAuth-ready (auth: ${server.authStatus})`);
  const read = server.tools[LINEAR_READ_TOOL];
  const write = server.tools[LINEAR_WRITE_TOOL];
  if (!read || !write) throw new Error(`Linear MCP server ${server.name} lacks get_issue/save_issue capabilities`);

  const readSchema = schemaObject(read);
  const readProperties = readSchema.properties as Record<string, unknown>;
  if (!Array.isArray(readSchema.required) || !readSchema.required.includes("id") || !propertyAllowsString(readProperties.id))
    throw new Error(`Linear MCP tool ${LINEAR_READ_TOOL} no longer requires a string id`);
  if (read.annotations?.readOnlyHint !== true || read.annotations?.destructiveHint !== false
      || read.annotations?.idempotentHint !== true || read.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_READ_TOOL} lacks safe read annotations`);

  const writeSchema = schemaObject(write);
  const writeProperties = writeSchema.properties as Record<string, unknown>;
  for (const property of ["id", "title", "description", "team"])
    if (!propertyAllowsString(writeProperties[property]))
      throw new Error(`Linear MCP tool ${LINEAR_WRITE_TOOL} lacks expected string field ${property}`);
  if (write.annotations?.readOnlyHint !== false || write.annotations?.destructiveHint !== true
      || write.annotations?.idempotentHint !== false || write.annotations?.openWorldHint !== false)
    throw new Error(`Linear MCP tool ${LINEAR_WRITE_TOOL} lacks explicit write annotations`);
}

function supportsLinear(server: McpServerInventory): boolean {
  return Boolean(server.tools[LINEAR_READ_TOOL] && server.tools[LINEAR_WRITE_TOOL]);
}

export function discoverLinearServer(servers: readonly McpServerInventory[], explicit?: string): McpServerInventory {
  if (explicit) {
    const matches = servers.filter(({ name }) => name === explicit);
    if (matches.length !== 1) throw new Error(`Configured Linear MCP server ${explicit} was not found exactly once`);
    gateLinearCapabilities(matches[0]);
    return matches[0];
  }
  const candidates = servers.filter(supportsLinear);
  if (candidates.length !== 1) {
    const names = candidates.map(({ name }) => name).sort().join(", ") || "none";
    throw new Error(`Expected exactly one Linear MCP server with get_issue/save_issue; found ${candidates.length} (${names})`);
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

function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512);
}

function textContent(result: McpToolResult): string[] {
  return result.content.flatMap((entry) => {
    if (!record(entry) || entry.type !== "text" || typeof entry.text !== "string") return [];
    return [entry.text];
  });
}

/** Normalize MCP output mechanically; no model is involved. */
export function normalizeLinearResult(result: McpToolResult): unknown {
  const text = textContent(result);
  if (result.isError) throw new Error(`Linear MCP tool failed${text.length ? `: ${safeText(text.join("\n"))}` : ""}`);
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
    const expected = envelope.method === LINEAR_READ_TOOL ? "read" : "write";
    if (envelope.access !== expected)
      throw new Error(`Linear MCP ${envelope.method} must be called through explicit ${expected} access`);
    const tool = this.inventory.tools[envelope.method];
    if (!tool) throw new Error(`Linear MCP method ${envelope.method} is not available`);
    validateArguments(tool, envelope.arguments);
    return normalizeLinearResult(await this.session.callTool({
      access: envelope.access,
      server: this.server,
      tool: envelope.method,
      arguments: envelope.arguments,
    }));
  }

  readIssue(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "read", method: LINEAR_READ_TOOL, arguments: arguments_ });
  }

  writeIssue(arguments_: Record<string, unknown>): Promise<unknown> {
    return this.call({ access: "write", method: LINEAR_WRITE_TOOL, arguments: arguments_ });
  }

  close(): Promise<void> { return this.session.close(); }
}

export async function openLinearGateway(broker: McpBroker, options: LinearGatewayOptions = {}): Promise<LinearGateway> {
  const session = await broker.open({ cwd: options.cwd });
  try {
    const server = discoverLinearServer(await session.listServers(), options.server);
    return new ConnectedLinearGateway(session, server);
  } catch (error) {
    await session.close();
    throw error;
  }
}

import type {
  McpAccess, McpBroker, McpBrokerOpenOptions, McpBrokerSession, McpServerInventory,
  McpToolDefinition, McpToolResult, ModelFreeTransportReceipt,
} from "./mcp-broker";
import { isIP } from "node:net";
import { canonicalJson, normalizeLinearConnector, normalizeLinearRemoteKey } from "./normalize";
import { parseStrictJson } from "../../strict-json";

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
  prepare(envelope: LinearCallEnvelope): PreparedLinearCall;
  call(envelope: LinearCallEnvelope): Promise<unknown>;
  readIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  listIssues(arguments_: Record<string, unknown>): Promise<unknown>;
  writeIssue(arguments_: Record<string, unknown>): Promise<unknown>;
  listComments(arguments_: Record<string, unknown>): Promise<unknown>;
  writeComment(arguments_: Record<string, unknown>): Promise<unknown>;
  transportReceipt(): ModelFreeTransportReceipt;
  close(): Promise<void>;
}

export interface PreparedLinearCall {
  dispatch(): Promise<unknown>;
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

const JSON_SCHEMA_TYPES = new Set([
  "null", "boolean", "object", "array", "number", "integer", "string",
]);
const SCHEMA_ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples",
  "deprecated", "readOnly", "writeOnly",
]);
const SUPPORTED_SCHEMA_ASSERTIONS = new Set([
  "type", "enum", "const", "anyOf", "oneOf", "allOf", "not",
  "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minProperties", "maxProperties",
  "format",
]);
const SUPPORTED_SCHEMA_FORMATS = new Set(["uri"]);
const MAX_SCHEMA_URI_BYTES = 16 * 1024;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const URI_PCHAR = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*$/;
const URI_PATH = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/;
const URI_QUERY_OR_FRAGMENT
  = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/;
const URI_USERINFO = /^(?:[A-Za-z0-9._~!$&'()*+,;=:-]|%[0-9A-Fa-f]{2})*$/;
const URI_REG_NAME = /^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*$/;
const URI_IPV_FUTURE
  = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/;

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The live MCP schema is an authority boundary for prepare-before-intent.
 * Silently ignoring an assertion keyword could defer a deterministic provider
 * rejection until after the durable intent. Audit the entire dialect at
 * discovery and fail closed on every assertion North does not implement.
 */
function assertSupportedSchema(schema: unknown, path: string): void {
  if (typeof schema === "boolean") return;
  if (!record(schema)) throw new Error(`Linear MCP schema at ${path} is not a JSON Schema`);
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_ANNOTATIONS.has(key) && !SUPPORTED_SCHEMA_ASSERTIONS.has(key))
      throw new Error(`Linear MCP schema at ${path} uses unsupported assertion keyword ${key}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))
        || new Set(types).size !== types.length)
      throw new Error(`Linear MCP schema at ${path}.type is invalid`);
  }
  if (schema.enum !== undefined
      && (!Array.isArray(schema.enum) || !schema.enum.length))
    throw new Error(`Linear MCP schema at ${path}.enum is invalid`);
  if (schema.format !== undefined
      && (typeof schema.format !== "string"
        || !SUPPORTED_SCHEMA_FORMATS.has(schema.format)))
    throw new Error(`Linear MCP schema at ${path}.format is unsupported`);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const alternatives = schema[key];
    if (alternatives === undefined) continue;
    if (!Array.isArray(alternatives) || !alternatives.length)
      throw new Error(`Linear MCP schema at ${path}.${key} is invalid`);
    alternatives.forEach((candidate, index) =>
      assertSupportedSchema(candidate, `${path}.${key}[${index}]`));
  }
  if (schema.not !== undefined) assertSupportedSchema(schema.not, `${path}.not`);
  if (schema.properties !== undefined) {
    if (!record(schema.properties))
      throw new Error(`Linear MCP schema at ${path}.properties is invalid`);
    for (const [key, child] of Object.entries(schema.properties))
      assertSupportedSchema(child, `${path}.properties.${key}`);
  }
  if (schema.required !== undefined
      && (!Array.isArray(schema.required)
        || schema.required.some((key) => typeof key !== "string")
        || new Set(schema.required).size !== schema.required.length))
    throw new Error(`Linear MCP schema at ${path}.required is invalid`);
  if (schema.additionalProperties !== undefined
      && typeof schema.additionalProperties !== "boolean")
    assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  if (schema.items !== undefined)
    assertSupportedSchema(schema.items, `${path}.items`);
  for (const key of [
    "minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties",
  ] as const) {
    if (schema[key] !== undefined && !nonnegativeInteger(schema[key]))
      throw new Error(`Linear MCP schema at ${path}.${key} is invalid`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean")
    throw new Error(`Linear MCP schema at ${path}.uniqueItems is invalid`);
  for (const key of [
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  ] as const) {
    if (schema[key] !== undefined
        && (typeof schema[key] !== "number" || !Number.isFinite(schema[key])))
      throw new Error(`Linear MCP schema at ${path}.${key} is invalid`);
  }
  for (const [minimum, maximum] of [
    ["minItems", "maxItems"],
    ["minLength", "maxLength"],
    ["minProperties", "maxProperties"],
  ] as const) {
    if (schema[minimum] !== undefined && schema[maximum] !== undefined
        && (schema[minimum] as number) > (schema[maximum] as number))
      throw new Error(`Linear MCP schema at ${path} has an inverted ${minimum}/${maximum} range`);
  }
}

function schemaObject(tool: McpToolDefinition): Schema {
  assertSupportedSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  if (!record(tool.inputSchema) || tool.inputSchema.type !== "object" || !record(tool.inputSchema.properties))
    throw new Error(`Linear MCP tool ${tool.name} has an incompatible input schema`);
  return tool.inputSchema;
}

function propertyAllowsString(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "string"
      || (Array.isArray(value.type) && value.type.includes("string")))
    return true;
  return ["anyOf", "oneOf"].some((key) =>
    Array.isArray(value[key]) && value[key].some(propertyAllowsString));
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

function jsonSchemaEqual(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function schemaMatches(schema: unknown, value: unknown, path: string): boolean {
  try {
    validateValue(schema, value, path);
    return true;
  } catch {
    return false;
  }
}

function invalidUri(path: string): Error {
  return new Error(
    `Linear MCP argument ${path} is outside North's supported absolute-URI profile`,
  );
}

function assertUriAuthority(value: string, path: string): boolean {
  const at = value.indexOf("@");
  if (at !== value.lastIndexOf("@"))
    throw invalidUri(path);
  const hostPort = at === -1 ? value : value.slice(at + 1);
  if (at !== -1 && !URI_USERINFO.test(value.slice(0, at)))
    throw invalidUri(path);
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    const literal = close < 0 ? "" : hostPort.slice(1, close);
    if (close < 0 || hostPort.indexOf("]", close + 1) !== -1
        || (isIP(literal) !== 6 && !URI_IPV_FUTURE.test(literal))) {
      throw invalidUri(path);
    }
    const port = hostPort.slice(close + 1);
    if (port && !/^:[0-9]+$/.test(port))
      throw invalidUri(path);
    return true;
  }
  if (hostPort.includes("[") || hostPort.includes("]"))
    throw invalidUri(path);
  const colon = hostPort.lastIndexOf(":");
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  const port = colon === -1 ? undefined : hostPort.slice(colon + 1);
  if (host.includes(":") || !URI_REG_NAME.test(host)
      || (port !== undefined && !/^[0-9]+$/.test(port))) {
    throw invalidUri(path);
  }
  return host.length > 0;
}

/**
 * North intentionally accepts a bounded, deterministic absolute-URI profile
 * instead of claiming universal RFC 3986 scheme semantics. Components are
 * ASCII with exact percent escapes; IP literals are IPv6 or IPvFuture; web
 * schemes require an authority and host; file may use an empty authority; and
 * non-authority identifiers must carry a non-empty hierarchy.
 */
function assertSupportedAbsoluteUri(value: string, path: string): void {
  const schemeAt = value.indexOf(":");
  if (schemeAt < 1 || !URI_SCHEME.test(value.slice(0, schemeAt)))
    throw invalidUri(path);
  const scheme = value.slice(0, schemeAt).toLowerCase();
  const remainder = value.slice(schemeAt + 1);
  const fragmentAt = remainder.indexOf("#");
  if (fragmentAt !== remainder.lastIndexOf("#"))
    throw invalidUri(path);
  const beforeFragment = fragmentAt === -1 ? remainder : remainder.slice(0, fragmentAt);
  const fragment = fragmentAt === -1 ? undefined : remainder.slice(fragmentAt + 1);
  if (fragment !== undefined && !URI_QUERY_OR_FRAGMENT.test(fragment))
    throw invalidUri(path);
  const queryAt = beforeFragment.indexOf("?");
  const hierarchy = queryAt === -1
    ? beforeFragment
    : beforeFragment.slice(0, queryAt);
  const query = queryAt === -1 ? undefined : beforeFragment.slice(queryAt + 1);
  if (query !== undefined && !URI_QUERY_OR_FRAGMENT.test(query))
    throw invalidUri(path);
  let hasAuthority = false;
  let hasHost = false;
  if (hierarchy.startsWith("//")) {
    hasAuthority = true;
    const authorityAndPath = hierarchy.slice(2);
    const pathAt = authorityAndPath.indexOf("/");
    const authority = pathAt === -1
      ? authorityAndPath
      : authorityAndPath.slice(0, pathAt);
    const uriPath = pathAt === -1 ? "" : authorityAndPath.slice(pathAt);
    hasHost = assertUriAuthority(authority, path);
    if (!URI_PATH.test(uriPath))
      throw invalidUri(path);
  } else {
    const firstSegment = hierarchy.split("/")[0]!;
    if (!URI_PATH.test(hierarchy)
        || (!hierarchy.startsWith("/") && hierarchy.length > 0
          && (firstSegment.length === 0 || !URI_PCHAR.test(firstSegment)))) {
      throw invalidUri(path);
    }
  }
  if ((scheme === "http" || scheme === "https") && (!hasAuthority || !hasHost))
    throw invalidUri(path);
  if (hasAuthority && !hasHost && scheme !== "file")
    throw invalidUri(path);
  if (!hasAuthority && hierarchy.length === 0)
    throw invalidUri(path);
}

function assertSchemaUri(value: string, path: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_SCHEMA_URI_BYTES) {
    throw invalidUri(path);
  }
  assertSupportedAbsoluteUri(value, path);
}

function validateValue(schema: unknown, value: unknown, path: string): void {
  if (schema === true) return;
  if (schema === false)
    throw new Error(`Linear MCP argument ${path} is rejected by its schema`);
  if (!record(schema)) throw new Error(`Unsupported Linear MCP schema at ${path}`);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => schemaMatches(candidate, value, path)))
      throw new Error(`Linear MCP argument ${path} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => schemaMatches(candidate, value, path)).length;
    if (matches !== 1)
      throw new Error(`Linear MCP argument ${path} does not match exactly one allowed schema`);
  }
  if (Array.isArray(schema.allOf))
    for (const candidate of schema.allOf) validateValue(candidate, value, path);
  if (schema.not !== undefined && schemaMatches(schema.not, value, path))
    throw new Error(`Linear MCP argument ${path} matches a forbidden schema`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonSchemaEqual(entry, value)))
    throw new Error(`Linear MCP argument ${path} is outside its allowed values`);
  if (Object.hasOwn(schema, "const") && !jsonSchemaEqual(schema.const, value))
    throw new Error(`Linear MCP argument ${path} does not equal its required constant`);
  if (schema.type !== undefined && !schemaTypeMatches(schema.type, value))
    throw new Error(`Linear MCP argument ${path} has the wrong type`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      throw new Error(`Linear MCP argument ${path} is shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      throw new Error(`Linear MCP argument ${path} is longer than maxLength ${schema.maxLength}`);
    if (schema.format === "uri") assertSchemaUri(value, path);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      throw new Error(`Linear MCP argument ${path} is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      throw new Error(`Linear MCP argument ${path} is above maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      throw new Error(`Linear MCP argument ${path} is not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      throw new Error(`Linear MCP argument ${path} is not below exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      throw new Error(`Linear MCP argument ${path} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      throw new Error(`Linear MCP argument ${path} has more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true) {
      const canonical = value.map((entry) => {
        try { return canonicalJson(entry); }
        catch { throw new Error(`Linear MCP argument ${path} contains a non-JSON item`); }
      });
      if (new Set(canonical).size !== canonical.length)
        throw new Error(`Linear MCP argument ${path} contains duplicate items`);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`));
  if (record(value)) {
    const propertyCount = Object.keys(value).length;
    if (typeof schema.minProperties === "number" && propertyCount < schema.minProperties)
      throw new Error(`Linear MCP argument ${path} has fewer than ${schema.minProperties} properties`);
    if (typeof schema.maxProperties === "number" && propertyCount > schema.maxProperties)
      throw new Error(`Linear MCP argument ${path} has more than ${schema.maxProperties} properties`);
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required)
      if (typeof key === "string" && !Object.hasOwn(value, key))
        throw new Error(`Linear MCP argument ${path}.${key} is required`);
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateValue(properties[key], entry, `${path}.${key}`);
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
  try {
    parsed = parseStrictJson(entry.text, "Linear MCP error text", {
      maxBytes: 4096,
      maxDepth: 32,
      maxNodes: 1000,
    });
  }
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
  try {
    return parseStrictJson(text.join("\n"), "Linear MCP result text", {
      maxBytes: 1024 * 1024,
    });
  }
  catch { throw new Error("Linear MCP tool returned non-JSON text without structuredContent"); }
}

class ConnectedLinearGateway implements LinearGateway {
  readonly server: string;
  constructor(
    private session: McpBrokerSession,
    private inventory: McpServerInventory,
  ) { this.server = inventory.name; }

  prepare(envelope: LinearCallEnvelope): PreparedLinearCall {
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
    const prepared = this.session.prepareTool({
      access: envelope.access,
      server: this.server,
      tool: method,
      arguments: envelope.arguments,
    });
    return {
      dispatch: async () => normalizeLinearResult(await prepared.dispatch(), method),
    };
  }

  async call(envelope: LinearCallEnvelope): Promise<unknown> {
    return this.prepare(envelope).dispatch();
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

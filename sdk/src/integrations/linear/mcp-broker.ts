export type McpAccess = "read" | "write";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

export interface McpServerInventory {
  name: string;
  authStatus: string;
  tools: Readonly<Record<string, McpToolDefinition>>;
}

export interface McpToolCall {
  access: McpAccess;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

export interface McpBrokerSession {
  listServers(): Promise<readonly McpServerInventory[]>;
  callTool(call: McpToolCall): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface McpBrokerOpenOptions {
  cwd?: string;
}

/** A model-free transport to MCP servers already authenticated by a provider surface. */
export interface McpBroker {
  open(options?: McpBrokerOpenOptions): Promise<McpBrokerSession>;
}

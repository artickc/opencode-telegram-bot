/**
 * Types for MCP (Model Context Protocol) server inspection & control.
 *
 * OpenCode loads MCP servers from its JSON config files: a global one at
 * `~/.config/opencode/opencode.json` and an optional per-workspace
 * `<cwd>/opencode.json`. MCP servers are under the `"mcp"` key with
 * `"type": "local"|"remote"`, `"command"` (array), `"url"` (remote),
 * `"enabled"` (default true), and `"environment"`.
 */

export type McpScope = "global" | "workspace";
export type McpTransport = "http" | "stdio" | "unknown";

/** Raw server definition as stored in an opencode.json `"mcp"` entry. */
export interface McpServerConfig {
  type?: "local" | "remote";
  command?: string[];
  url?: string;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  enabled?: boolean;
  [k: string]: unknown;
}

/** A configured server resolved from a specific config file. */
export interface McpServer {
  name: string;
  scope: McpScope;
  /** Absolute path of the config file this server is defined in. */
  configPath: string;
  /** True when the server is explicitly disabled (enabled: false). */
  disabled: boolean;
  transport: McpTransport;
  /** Short transport descriptor for display (command or url, trimmed). */
  detail: string;
  config: McpServerConfig;
}

/** Result of a live connection probe (MCP `initialize` handshake). */
export interface McpProbeResult {
  name: string;
  ok: boolean;
  /** Round-trip time in ms when ok. */
  ms?: number;
  /** Server-reported name/version when ok. */
  serverName?: string;
  serverVersion?: string;
  /** Human-readable failure reason when not ok. */
  error?: string;
  /** True when the server was skipped because it is disabled. */
  skipped?: boolean;
}

export function transportOf(c: McpServerConfig): McpTransport {
  if (c.type === "remote" || (typeof c.url === "string" && c.url.trim())) return "http";
  if (c.type === "local" || (Array.isArray(c.command) && c.command.length)) return "stdio";
  return "unknown";
}

export function detailOf(c: McpServerConfig): string {
  if (typeof c.url === "string" && c.url.trim()) return c.url.trim();
  if (Array.isArray(c.command) && c.command.length) {
    return c.command.join(" ").trim();
  }
  return "(no command/url)";
}

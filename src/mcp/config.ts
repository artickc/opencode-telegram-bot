/**
 * MCP config store — reads and edits OpenCode's MCP server configuration.
 *
 * Sources, in precedence order for display (a workspace entry shadows a global
 * one with the same name, mirroring how OpenCode merges them):
 *   • global    → `~/.config/opencode/opencode.json`  (and `.jsonc`)
 *   • also      → `~/.opencode/opencode.json`          (legacy / alternate home)
 *   • workspace → `<cwd>/opencode.json` / `.jsonc`
 *
 * OpenCode configs are often JSONC (comments + trailing commas). We parse with
 * a JSONC stripper; toggles use a surgical text edit so we don't rewrite the
 * whole file and wipe comments / formatting.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { tryParseJsonc } from "./jsonc.js";
import { detailOf, type McpScope, type McpServer, type McpServerConfig, transportOf } from "./types.js";

const log = createLogger("mcp:config");

/** opencode.json structure — MCP servers live under the `"mcp"` key. */
interface OpenCodeConfig {
  mcp?: Record<string, McpServerConfig>;
  [k: string]: unknown;
}

/** Candidate global config paths (first existing wins for writes; all are read). */
export function globalMcpCandidates(): string[] {
  const home = homedir();
  return [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".opencode", "opencode.json"),
    join(home, ".opencode", "opencode.jsonc"),
  ];
}

/** Absolute path of the preferred global opencode.json (may not exist yet). */
export function globalMcpPath(): string {
  for (const p of globalMcpCandidates()) {
    if (existsSync(p)) return p;
  }
  return globalMcpCandidates()[0]!;
}

/** Workspace config candidates under a project directory. */
export function workspaceMcpCandidates(cwd: string): string[] {
  return [join(cwd, "opencode.json"), join(cwd, "opencode.jsonc"), join(cwd, ".opencode", "opencode.json")];
}

/** Absolute path of a workspace opencode.json for a given project directory. */
export function workspaceMcpPath(cwd: string): string {
  for (const p of workspaceMcpCandidates(cwd)) {
    if (existsSync(p)) return p;
  }
  return workspaceMcpCandidates(cwd)[0]!;
}

function readConfig(path: string): OpenCodeConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = tryParseJsonc<OpenCodeConfig>(raw);
    if (!parsed) {
      log.warn(`cannot parse ${path} as JSON/JSONC`);
      return undefined;
    }
    return parsed;
  } catch (e) {
    log.warn(`cannot read ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

function serversFrom(path: string, scope: McpScope): McpServer[] {
  const file = readConfig(path);
  const map = file?.mcp;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map).map(([name, config]) => ({
    name,
    scope,
    configPath: path,
    disabled: config?.enabled === false,
    transport: transportOf(config ?? {}),
    detail: detailOf(config ?? {}),
    config: config ?? {},
  }));
}

/**
 * List all configured MCP servers. Workspace entries shadow global ones with
 * the same name. Returns them sorted by name (case-insensitive).
 */
export function listMcpServers(cwd?: string): McpServer[] {
  const byName = new Map<string, McpServer>();
  // Global candidates: later files of the same name do not override earlier
  // ones (first discovery wins for a given name among globals).
  for (const p of globalMcpCandidates()) {
    for (const s of serversFrom(p, "global")) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
  }
  if (cwd) {
    for (const p of workspaceMcpCandidates(cwd)) {
      for (const s of serversFrom(p, "workspace")) {
        byName.set(s.name, s); // workspace always wins
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Locate a single server by name (workspace shadows global). */
export function findMcpServer(name: string, cwd?: string): McpServer | undefined {
  return listMcpServers(cwd).find((s) => s.name === name);
}

export interface ToggleResult {
  ok: boolean;
  /** New disabled state on success. */
  disabled?: boolean;
  error?: string;
}

/**
 * Set the `enabled` flag for a server in its own config file. The change takes
 * effect when the agent next (re)loads servers (after `/restart` / new session).
 *
 * Uses a surgical text edit so JSONC comments and the rest of the large
 * opencode.json (models, providers, …) stay intact.
 */
export function setMcpDisabled(server: McpServer, disabled: boolean): ToggleResult {
  if (!existsSync(server.configPath)) {
    return { ok: false, error: `config file missing: ${server.configPath}` };
  }
  let text: string;
  try {
    text = readFileSync(server.configPath, "utf-8");
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const edited = patchMcpEnabled(text, server.name, !disabled);
  if (!edited.ok) {
    // Fallback: full parse + rewrite of the whole file (last resort).
    const file = readConfig(server.configPath);
    if (!file?.mcp?.[server.name]) {
      return { ok: false, error: edited.error ?? `server "${server.name}" not found` };
    }
    const entry = file.mcp[server.name]!;
    if (disabled) entry.enabled = false;
    else delete entry.enabled;
    try {
      writeFileSync(server.configPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
      log.warn(`rewrote ${server.configPath} as strict JSON (JSONC comments may be lost)`);
      return { ok: true, disabled };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  try {
    writeFileSync(server.configPath, edited.text!, "utf-8");
    return { ok: true, disabled };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Surgically set or clear `"enabled"` inside `"name": { ... }` under `"mcp"`.
 * Returns the new file text on success.
 */
export function patchMcpEnabled(
  text: string,
  serverName: string,
  enabled: boolean,
): { ok: true; text: string } | { ok: false; error: string } {
  // Locate `"name": {`  (name may contain dots, dashes, etc.)
  const nameRe = new RegExp(`("${escapeRegExp(serverName)}"\\s*:\\s*\\{)`, "m");
  const m = nameRe.exec(text);
  if (!m || m.index === undefined) {
    return { ok: false, error: `server entry "${serverName}" not found` };
  }
  const braceStart = m.index + m[1]!.length - 1; // index of `{`
  const braceEnd = findMatchingBrace(text, braceStart);
  if (braceEnd < 0) return { ok: false, error: `unbalanced braces for "${serverName}"` };

  const before = text.slice(0, braceStart + 1);
  let body = text.slice(braceStart + 1, braceEnd);
  const after = text.slice(braceEnd);

  // Remove any existing "enabled" property (true or false).
  body = body.replace(/,?\s*"enabled"\s*:\s*(true|false)\s*,?/g, (match, _v, offset, whole) => {
    // Keep a comma if we removed one from the middle of a property list.
    const left = whole.slice(0, offset).trimEnd();
    const right = whole.slice(offset + match.length).trimStart();
    if (left.endsWith("{") || left.endsWith(",")) return right.startsWith(",") ? "" : "";
    if (right.startsWith("}")) return "";
    return match.includes(",") ? "," : "";
  });
  // Clean double commas / leading commas after removal.
  body = body
    .replace(/,\s*,/g, ",")
    .replace(/\{\s*,/g, "{")
    .replace(/,\s*([}\]])/g, "$1");

  if (!enabled) {
    // Insert `"enabled": false` after the opening brace.
    const indent = detectIndent(body) || "\n    ";
    body = `${indent}"enabled": false,` + body.replace(/^\n?/, "\n");
  }

  return { ok: true, text: before + body + after };
}

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function detectIndent(body: string): string {
  const m = /^\n([ \t]+)/.exec(body);
  return m ? "\n" + m[1] : "\n    ";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format tool-call updates into clean, compact RAW markdown cards for Telegram.
 *
 * Design rules:
 *  - One short header line: icon + action + path/pattern (never dump the body).
 *  - Body only when useful (command fence, smart-truncated diff, short preview).
 *  - Status is a small trailing mark (⏳ / ✅ / ❌), not a second headline.
 *  - Long multi-line titles from OpenCode ACP are cleaned to a human label.
 */
import type { SessionUpdate, ToolCallContent } from "../opencode/types.js";
import { diffStatBadge, renderUnifiedDiff } from "./diff.js";

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  edit: "\u270F\uFE0F",
  write: "\u{1F4DD}",
  execute: "\u{1F4BB}",
  search: "\u{1F50E}",
  delete: "\u{1F5D1}\uFE0F",
  move: "\u{1F4E6}",
  fetch: "\u{1F310}",
  think: "\u{1F4AD}",
  other: "\u{1F527}",
};

const STATUS_ICON: Record<string, string> = {
  pending: "\u25AB", // ▫ quiet mark while queued
  in_progress: "\u23F3",
  completed: "\u2705",
  failed: "\u274C",
};

/** Max characters of a shell command shown in a fence. */
const CMD_MAX = 500;
/** Max characters of a write/read preview. */
const PREVIEW_MAX = 280;
/** Max path display length. */
const PATH_MAX = 48;

export interface ToolFormatOptions {
  showDiffs: boolean;
  diffMaxLines: number;
}

/** Returns a RAW markdown block describing the tool call, or "" to skip. */
export function formatToolCall(u: SessionUpdate, opts: ToolFormatOptions): string {
  const raw = (u.rawInput || {}) as Record<string, unknown>;
  const kind = normalizeKind(u.kind, u.title, raw);
  const status = u.status ? (STATUS_ICON[u.status] ?? "") : "";
  const mark = status ? ` ${status}` : "";

  // Skill load — reading a `.../skills/<name>/SKILL.md`.
  if (kind !== "edit" && kind !== "delete" && kind !== "move" && kind !== "write") {
    const skill = detectSkill(u, raw);
    if (skill) return `\u{1F4DA} **Skill** \u00B7 ${skill}${mark}`;
  }

  // MCP / extension tool.
  const mcp = detectMcp(u, raw, kind);
  if (mcp) {
    const label = mcp.server ? `${mcp.server}/${mcp.method}` : mcp.method;
    return `\u{1F9E9} **MCP** \u00B7 \`${trunc(label, 60)}\`${mark}`;
  }

  const icon: string = KIND_ICON[kind] ?? KIND_ICON.other ?? "\u{1F527}";
  const path = shortPath(strOf(raw.path ?? raw.file_path ?? raw.filename ?? raw.file ?? firstPath(u, raw)));

  switch (kind) {
    case "execute":
      return formatExecute(icon, raw, u, mark);
    case "search":
      return formatSearch(icon, raw, path, mark);
    case "read":
      return formatRead(icon, raw, path, mark);
    case "edit":
    case "write":
      return formatEdit(icon, kind, u, raw, path, mark, opts);
    case "delete":
      return `${icon} **Delete** \u00B7 \`${path || "?"}\`${mark}`;
    case "move":
      return formatMove(icon, raw, mark);
    case "fetch":
      return formatFetch(icon, raw, mark);
    default:
      return formatGeneric(icon, u, raw, path, mark);
  }
}

// ── kind-specific cards ──────────────────────────────────────────────────────

function formatExecute(icon: string, raw: Record<string, unknown>, u: SessionUpdate, mark: string): string {
  const cmd = cleanCommand(
    strOf(raw.command ?? raw.cmd ?? raw.script ?? raw.input ?? raw.args) || extractCmdFromTitle(u.title),
  );
  const cwd = shortPath(strOf(raw.cwd ?? raw.workdir ?? raw.working_directory));
  const head = cwd ? `${icon} **Run** \u00B7 \`${cwd}\`${mark}` : `${icon} **Run**${mark}`;
  if (!cmd) return head;
  const shown = cmd.length > CMD_MAX ? cmd.slice(0, CMD_MAX - 1) + "\u2026" : cmd;
  return `${head}\n\`\`\`bash\n${shown}\n\`\`\``;
}

function formatSearch(icon: string, raw: Record<string, unknown>, path: string, mark: string): string {
  const pattern = strOf(raw.pattern ?? raw.query ?? raw.regex ?? raw.include ?? raw.glob);
  const where = path || shortPath(strOf(raw.path ?? raw.directory ?? raw.dir)) || ".";
  const pat = pattern ? trunc(pattern, 40) : "";
  const head = pat
    ? `${icon} **Search** \u00B7 \`${escapeTicks(pat)}\` in \`${where}\`${mark}`
    : `${icon} **Search** \u00B7 \`${where}\`${mark}`;
  return head;
}

function formatRead(icon: string, raw: Record<string, unknown>, path: string, mark: string): string {
  const p = path || shortPath(strOf(raw.path)) || cleanTitle(strOf(raw.title)) || "file";
  const line = raw.line ?? raw.offset ?? raw.start_line;
  const suffix = typeof line === "number" || typeof line === "string" ? `:${line}` : "";
  return `${icon} **Read** \u00B7 \`${p}${suffix}\`${mark}`;
}

function formatEdit(
  icon: string,
  kind: string,
  u: SessionUpdate,
  raw: Record<string, unknown>,
  path: string,
  mark: string,
  opts: ToolFormatOptions,
): string {
  const p = path || shortPath(strOf(raw.path)) || "file";
  const action = kind === "write" ? "Write" : "Edit";
  let out = `${icon} **${action}** \u00B7 \`${p}\`${mark}`;

  if (!opts.showDiffs) return out;

  // Only expand the body once the tool has useful content (in_progress/completed).
  // Pending cards stay one-liners so the chat doesn't flash empty fences.
  const status = (u.status || "").toLowerCase();
  if (status === "pending") return out;

  const diff = buildEditDiff(u, raw, opts.diffMaxLines);
  if (diff?.block) {
    const badge = diffStatBadge(diff.added, diff.removed);
    if (badge) out += `  \`${badge}\``;
    if (diff.truncated) out += " \u00B7 truncated";
    out += `\n${diff.block}`;
    return out;
  }

  // Write without old text — show a short content preview instead of a full dump.
  const content = strOf(raw.file_text ?? raw.content ?? raw.text ?? raw.new_str ?? raw.newStr);
  if (content && kind === "write") {
    out += `\n\`\`\`\n${previewText(content, PREVIEW_MAX)}\n\`\`\``;
  }
  return out;
}

function formatMove(icon: string, raw: Record<string, unknown>, mark: string): string {
  const from = shortPath(strOf(raw.from ?? raw.source ?? raw.old_path ?? raw.path));
  const to = shortPath(strOf(raw.to ?? raw.dest ?? raw.destination ?? raw.new_path));
  if (from && to) return `${icon} **Move** \u00B7 \`${from}\` \u2192 \`${to}\`${mark}`;
  return `${icon} **Move** \u00B7 \`${from || to || "?"}\`${mark}`;
}

function formatFetch(icon: string, raw: Record<string, unknown>, mark: string): string {
  const url = strOf(raw.url ?? raw.href ?? raw.uri);
  return url
    ? `${icon} **Fetch** \u00B7 ${trunc(url, 60)}${mark}`
    : `${icon} **Fetch**${mark}`;
}

function formatGeneric(
  icon: string,
  u: SessionUpdate,
  raw: Record<string, unknown>,
  path: string,
  mark: string,
): string {
  const label = cleanTitle(u.title) || capitalize(strOf(raw.tool ?? raw.name) || "tool");
  const detail = path ? ` \u00B7 \`${path}\`` : "";
  return `${icon} **${trunc(label, 40)}**${detail}${mark}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Map OpenCode/ACP tool names onto our kind set. */
function normalizeKind(kind: string | undefined, title: string | undefined, raw: Record<string, unknown>): string {
  const k = (kind || "").toLowerCase().trim();
  if (k && k !== "other") {
    if (k === "write" || k === "create") return raw.old_str || raw.oldStr || raw.oldText ? "edit" : "write";
    if (k === "bash" || k === "shell" || k === "run" || k === "terminal") return "execute";
    if (k === "grep" || k === "glob" || k === "find") return "search";
    if (k === "read" || k === "view" || k === "cat") return "read";
    if (k === "edit" || k === "patch" || k === "replace" || k === "strreplace") return "edit";
    return k;
  }
  // Infer from title / raw fields when kind is missing (common on ACP tool_call_update).
  const t = (title || "").toLowerCase();
  if (raw.command || raw.cmd || raw.script || t === "bash" || t === "shell") return "execute";
  if (raw.pattern || raw.query || t.includes("grep") || t.includes("glob") || t.includes("search")) return "search";
  if (raw.old_str || raw.oldStr || raw.new_str || raw.newStr) return "edit";
  if (raw.file_text || raw.content) return raw.path || raw.file_path ? "write" : "other";
  if (raw.path || raw.file_path) return "read";
  return "other";
}

function cleanCommand(cmd: string): string {
  let c = cmd.trim();
  // Strip a leading comment-only first line that OpenCode sometimes puts in the title.
  c = c.replace(/^#[^\n]*\n+/, "");
  // Collapse runs of spaces inside a single line (keep newlines for scripts).
  c = c
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
  return c;
}

function extractCmdFromTitle(title: string | undefined): string {
  if (!title) return "";
  const t = title.trim();
  // Title is often the raw command once the tool is in_progress.
  if (t.toLowerCase() === "bash" || t.toLowerCase() === "shell") return "";
  // Multi-line title: prefer lines that look like shell, drop pure comments.
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const code = lines.filter((l) => !l.startsWith("#"));
  return (code.length ? code : lines).join("\n");
}

function cleanTitle(title: string | undefined): string {
  if (!title) return "";
  // Never use a multi-line dump as a bold title.
  const first = title.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  if (first.length > 60) return trunc(first, 60);
  return first;
}

function shortPath(p: string): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  // Keep last 2 segments when long (src/foo/bar.ts → foo/bar.ts).
  const parts = norm.split("/").filter(Boolean);
  let short = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/") || norm;
  if (short.length > PATH_MAX) short = "\u2026" + short.slice(-(PATH_MAX - 1));
  return short;
}

function previewText(text: string, max: number): string {
  const t = text.replace(/\r\n/g, "\n").trimEnd();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.65);
  const tail = max - head - 5;
  return t.slice(0, head) + "\n\u2026\n" + t.slice(-tail);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function escapeTicks(s: string): string {
  return s.replace(/`/g, "'");
}

/** Built-in OpenCode tools that must never be labelled as MCP calls. */
const BUILTIN_TOOLS = new Set([
  "read", "write", "shell", "bash", "grep", "glob", "web_fetch", "web_search", "fs_read",
  "fs_write", "fs_replace", "fs_search", "execute_bash", "report_issue", "use_aws",
  "todo_list", "introspect", "knowledge", "thinking", "summary", "subagent", "edit",
  "list", "apply_patch", "str_replace", "search_replace",
]);
const FILE_KINDS = new Set(["read", "edit", "write", "execute", "search", "delete", "move"]);
const SKILL_RE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
const MCP_NS = [
  /^@([a-z0-9._-]+)[/_]{1,3}(.+)$/i,
  /^([a-z0-9.-]+)___(.+)$/i,
  /^([a-z0-9.-]+)__(.+)$/i,
  /^([a-z0-9.-]+)\/(.+)$/i,
  /^([a-z0-9-]+)\.(.+)$/i,
];

function detectSkill(u: SessionUpdate, raw: Record<string, unknown>): string | undefined {
  for (const p of gatherPaths(u, raw)) {
    const m = SKILL_RE.exec(p);
    if (m) return m[1];
  }
  return undefined;
}

function detectMcp(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  kind: string,
): { server?: string; method: string } | undefined {
  const name = mcpToolName(u, raw);
  if (!name) return undefined;
  for (const re of MCP_NS) {
    const m = re.exec(name);
    if (m) return { server: m[1]!, method: m[2]! };
  }
  if (!BUILTIN_TOOLS.has(name.toLowerCase()) && !FILE_KINDS.has(kind)) {
    return { method: name };
  }
  return undefined;
}

function mcpToolName(u: SessionUpdate, raw: Record<string, unknown>): string {
  const explicit = strOf(raw.tool_name) || strOf(raw.toolName) || strOf(raw.name) || strOf(raw.tool);
  if (explicit) return explicit;
  const t = (u.title || "").trim();
  return /^[@a-z0-9._/-]+$/i.test(t) && !t.includes(":") ? t : "";
}

function gatherPaths(u: SessionUpdate, raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v) out.push(v);
  };
  add(raw.path);
  add(raw.file_path);
  add(raw.filename);
  add(raw.file);
  if (Array.isArray(raw.operations)) {
    for (const op of raw.operations) {
      if (op && typeof op === "object") add((op as Record<string, unknown>).path);
    }
  }
  for (const b of collectContent(u)) add(b.path);
  return out;
}

function firstPath(u: SessionUpdate, raw: Record<string, unknown>): string {
  return gatherPaths(u, raw)[0] ?? "";
}

function buildEditDiff(u: SessionUpdate, raw: Record<string, unknown>, maxLines: number) {
  const blocks = collectContent(u);
  const diffBlock = blocks.find((b) => b.type === "diff");
  if (diffBlock) {
    return renderUnifiedDiff({
      path: strOf(diffBlock.path) || strOf(raw.path) || "file",
      oldText: typeof diffBlock.oldText === "string" ? diffBlock.oldText : "",
      newText: typeof diffBlock.newText === "string" ? diffBlock.newText : "",
      maxLines,
    });
  }
  // Nested content blocks sometimes carry text as content.content.text
  for (const b of blocks) {
    if (b.type === "content" && b.content && typeof b.content === "object") {
      const nested = b.content as { text?: string };
      if (typeof nested.text === "string" && (raw.old_str || raw.oldStr)) {
        return renderUnifiedDiff({
          path: strOf(raw.path) || "file",
          oldText: strOf(raw.old_str ?? raw.oldStr),
          newText: nested.text,
          maxLines,
        });
      }
    }
  }
  const oldStr = strOf(raw.old_str ?? raw.oldStr ?? raw.oldText ?? raw.before);
  const newStr = strOf(raw.new_str ?? raw.newStr ?? raw.newText ?? raw.after);
  if (oldStr || newStr) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: oldStr, newText: newStr, maxLines });
  }
  // Full-file write: show as a synthetic add-only diff of the preview only when small.
  const content = strOf(raw.file_text ?? raw.content ?? raw.text);
  if (content && content.length <= 2000) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: "", newText: content, maxLines });
  }
  return undefined;
}

function collectContent(u: SessionUpdate): ToolCallContent[] {
  const out: ToolCallContent[] = [];
  if (Array.isArray(u.content_blocks)) out.push(...u.content_blocks);
  const content = (u as unknown as { content?: unknown }).content;
  if (Array.isArray(content)) out.push(...(content as ToolCallContent[]));
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

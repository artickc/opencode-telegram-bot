/**
 * OpenCode client — spawns `opencode serve` and communicates via the
 * @opencode-ai/sdk HTTP/SSE API.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { Part, Permission, Session as OCSession, SessionStatus, TextPart, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk";
import { createLogger } from "../logger.js";
import type { ContentBlock, InitializeResult, PendingStage, PermissionOutcome, PromptResult, RequestPermissionParams, SessionUpdate, SubagentInfo, SubagentListUpdate } from "./types.js";

const log = createLogger("oc:client");

export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  credits?: number;
}

export class OcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "OcError";
  }
}

const TRANSIENT_RE = /internal error|high volume|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|connection (?:reset|closed|refused)|reset by peer|broken pipe|socket hang ?up|econnreset|econnrefused|etimedout|\b50[234]\b|\b429\b/i;
const CONTEXT_EXHAUSTED_RE = /context (?:length|window|limit|overflow)|maximum context|input (?:is )?too long|too many (?:input )?tokens|token limit|exceeds? (?:the )?(?:maximum|context|token)|context.{0,24}exhaust/i;

export function isTransientOcError(err: Error): boolean {
  const code = (err as OcError).code;
  if (typeof code === "number" && [429, 500, 502, 503, 504].includes(code)) return true;
  return TRANSIENT_RE.test(err.message);
}
export function isContextExhaustedError(err: Error): boolean {
  return CONTEXT_EXHAUSTED_RE.test(err.message);
}
/** Compat alias. */
export const isTransientAcpError = isTransientOcError;

export interface OcClientOptions {
  opencodePath: string;
  workspace: string;
  trustAllTools: boolean;
  agent?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  promptIdleTimeoutMs?: number;
  promptMaxMs?: number;
}

interface PendingPrompt {
  resolve: (v: PromptResult) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  sessionId: string;
}

export declare interface OpenCodeClient {
  on(e: "session-update", l: (sessionId: string, update: SessionUpdate) => void): this;
  on(e: "notification", l: (method: string, params: unknown) => void): this;
  on(e: "exit", l: (code: number | null) => void): this;
  on(e: "restarted", l: () => void): this;
  on(e: "subagents", l: (s: SubagentInfo[], p: PendingStage[]) => void): this;
  emit(e: "session-update", sessionId: string, update: SessionUpdate): boolean;
  emit(e: "notification", method: string, params: unknown): boolean;
  emit(e: "exit", code: number | null): boolean;
  emit(e: "restarted"): boolean;
  emit(e: "subagents", s: SubagentInfo[], p: PendingStage[]): boolean;
}

export class OpenCodeClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private sdk?: OpencodeClient;
  private serverUrl?: string;
  private eventLoopActive = false;
  private nextId = 1;
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly timeout: number;
  private readonly promptIdleMs: number;
  private readonly promptMaxMs: number;
  private readonly lastActivity = new Map<string, number>();
  private lastActivityAny = 0;
  private stopped = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;

  agentInfo?: { name?: string; version?: string };
  capabilities?: InitializeResult["agentCapabilities"];
  availableModes: Array<{ id: string; name: string; description?: string }> = [];
  currentModeId?: string;
  availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
  currentModelId?: string;
  connectedProviders: string[] = [];

  private readonly metadata = new Map<string, SessionMetadata>();
  private subagents: SubagentInfo[] = [];
  private pendingStages: PendingStage[] = [];

  // Per-session tracking for prompt-time application
  private readonly sessionCwds = new Map<string, string>();
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionAgents = new Map<string, string>();

  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  constructor(private readonly opts: OcClientOptions) {
    super();
    this.setMaxListeners(0);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs ?? 6 * 60 * 60_000;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const port = await this.findFreePort();
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    log.info(`spawning: ${this.opts.opencodePath} ${args.join(" ")}`);

    const proc = spawn(this.opts.opencodePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env: { ...process.env },
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      log.warn(`opencode serve exited (code ${code})`);
      this.failAllPending(new Error(`opencode serve exited (code ${code})`));
      this.emit("exit", code);
      this.maybeRestart();
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      log.error("failed to spawn opencode:", err.message);
      this.failAllPending(err);
    });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) log.debug("[opencode stderr]", msg.slice(0, 500));
    });

    this.serverUrl = `http://127.0.0.1:${port}`;
    await this.waitForServer();
    this.sdk = createOpencodeClient({ baseUrl: this.serverUrl, directory: this.opts.workspace });
    this.restartAttempts = 0;
    this.subagents = [];
    this.pendingStages = [];
    this.agentInfo = { name: "opencode", version: "1.0.0" };
    this.capabilities = { loadSession: true, promptCapabilities: { image: true } };

    this.startEventLoop();
    await this.discoverAgents();
    log.info(`connected: opencode at ${this.serverUrl}`);
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close();
          reject(new Error("Failed to find free port"));
        }
      });
      server.on("error", reject);
    });
  }

  private async waitForServer(maxWaitMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.serverUrl}/session`, { signal: controller.signal, headers: { Accept: "application/json" } });
        clearTimeout(timeout);
        if (res.ok || res.status === 401 || res.status === 400) return;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`opencode serve did not become ready within ${maxWaitMs}ms`);
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  private async discoverAgents(): Promise<void> {
    if (!this.sdk) return;

    // Agents (build, plan, etc.)
    try {
      const res = await this.sdk.app.agents();
      if (res.data && Array.isArray(res.data)) {
        this.availableModes = res.data.map((a: Record<string, unknown>) => ({
          id: String(a.name ?? ""),
          name: String(a.name ?? ""),
          description: typeof a.description === "string" ? a.description : undefined,
        }));
      }
    } catch (e) {
      log.debug("agent discovery failed:", (e as Error).message);
    }

    // Models — use sdk.provider.list() which returns ALL providers + models + connected status
    try {
      const res = await this.sdk.provider.list();
      if (res.data) {
        const data = res.data as {
          all?: Array<{ id: string; name?: string; env?: string[]; models?: Record<string, { name?: string; status?: string }> }>;
          connected?: string[];
          default?: Record<string, string>;
        };
        this.connectedProviders = data.connected ?? [];
        const models: Array<{ modelId: string; name: string; description?: string }> = [];
        for (const p of data.all ?? []) {
          const pid = p.id;
          const pname = p.name ?? pid;
          const isConnected = this.connectedProviders.includes(pid);
          if (p.models && typeof p.models === "object") {
            for (const [mid, meta] of Object.entries(p.models)) {
              const mname = meta?.name ?? mid;
              const status = meta?.status ? ` (${meta.status})` : "";
              models.push({
                modelId: `${pid}/${mid}`,
                name: `${mname}${status}`,
                description: isConnected ? `${pname} ✓` : `${pname} (not connected)`,
              });
            }
          }
        }
        this.availableModels = models;
        log.info(`discovered ${models.length} models from ${data.all?.length ?? 0} providers (${this.connectedProviders.length} connected)`);
      }
    } catch (e) {
      log.debug("model discovery failed:", (e as Error).message);
    }
  }

  // ── Provider management ────────────────────────────────────────────────────

  async getProviderAuth(): Promise<Record<string, Array<{ type: string; label: string }>>> {
    if (!this.sdk) return {};
    try {
      const res = await this.sdk.provider.auth();
      if (res.data) return res.data as Record<string, Array<{ type: string; label: string }>>;
    } catch (e) {
      log.debug("provider.auth failed:", (e as Error).message);
    }
    return {};
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      const res = await this.sdk.auth.set({ path: { id: providerId }, body: { type: "api", key: apiKey } });
      if (!res.error) {
        if (!this.connectedProviders.includes(providerId)) this.connectedProviders.push(providerId);
        await this.discoverAgents();
        return true;
      }
    } catch (e) {
      log.error("auth.set failed:", (e as Error).message);
    }
    return false;
  }

  /** Disconnect a provider by removing its auth credentials. */
  async disconnectProvider(providerId: string): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      // Set an empty key to clear credentials
      const res = await this.sdk.auth.set({ path: { id: providerId }, body: { type: "api", key: "" } });
      if (!res.error) {
        this.connectedProviders = this.connectedProviders.filter((p) => p !== providerId);
        await this.discoverAgents();
        return true;
      }
    } catch (e) {
      log.error("disconnect failed:", (e as Error).message);
    }
    return false;
  }

  getConnectedProviders(): string[] { return this.connectedProviders.slice(); }
  isProviderConnected(id: string): boolean { return this.connectedProviders.includes(id); }
  async refreshDiscovery(): Promise<void> { await this.discoverAgents(); }

  // ── Session management ─────────────────────────────────────────────────────

  get supportsLoadSession(): boolean { return true; }
  hasInflightPrompt(): boolean { return this.pending.size > 0; }
  get pid(): number | undefined { return this.proc?.pid; }

  async newSession(cwd: string): Promise<string> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    const res = await this.sdk.session.create({ query: { directory: cwd }, body: {} });
    if (res.error || !res.data) throw new OcError("session.create failed", res.response?.status);
    this.sessionCwds.set(res.data.id, cwd);
    return res.data.id;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    this.sessionCwds.set(sessionId, cwd);
    const res = await this.sdk.session.get({ path: { id: sessionId }, query: { directory: cwd } });
    if (res.error || !res.data) throw new OcError("session.load failed", res.response?.status);
  }

  hasMode(id: string): boolean { return this.availableModes.some((m) => m.id === id); }
  hasModel(id: string): boolean { return id === "auto" || this.availableModels.some((m) => m.modelId === id || m.modelId.endsWith(`/${id}`)); }

  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      if (!this.sdk) { reject(new Error("opencode serve is not running")); return; }
      const promptId = `p-${this.nextId++}`;
      const start = Date.now();
      this.lastActivity.set(sessionId, start);

      const parts = content.map((cb) => {
        if (cb.type === "text") return { type: "text" as const, text: cb.text ?? "" };
        if (cb.type === "image" && cb.data) return { type: "file" as const, mime: cb.mimeType ?? "image/png", url: `data:${cb.mimeType};base64,${cb.data}` };
        return { type: "text" as const, text: cb.text ?? JSON.stringify(cb) };
      });

      const watch = setInterval(() => {
        const last = Math.max(this.lastActivity.get(sessionId) ?? start, this.lastActivityAny);
        const idle = Date.now() - last;
        const total = Date.now() - start;
        if (total > this.promptMaxMs) {
          this.pending.delete(promptId); clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          this.pending.delete(promptId); clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);

      this.pending.set(promptId, { resolve, reject, cleanup: () => clearInterval(watch), sessionId });

      const cwd = this.sessionCwds.get(sessionId) ?? this.opts.workspace;
      const sessionModel = this.sessionModels.get(sessionId);
      const sessionAgent = this.sessionAgents.get(sessionId) ?? this.opts.agent;
      const body = { parts, ...(sessionAgent ? { agent: sessionAgent } : {}), ...(sessionModel && sessionModel.indexOf("/") > 0 ? { model: { providerID: sessionModel.slice(0, sessionModel.indexOf("/")), modelID: sessionModel.slice(sessionModel.indexOf("/") + 1) } } : {}) };

      this.sdk!.session.promptAsync({ path: { id: sessionId }, query: { directory: cwd }, body })
        .then((res) => {
          if (res.error) { this.pending.delete(promptId); clearInterval(watch); reject(new OcError("prompt failed", res.response?.status)); }
        })
        .catch((err) => { this.pending.delete(promptId); clearInterval(watch); reject(err as Error); });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.sdk) return;
    try { await this.sdk.session.abort({ path: { id: sessionId } }); } catch (e) { log.debug("abort failed:", (e as Error).message); }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    this.sessionModels.set(sessionId, modelId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.currentModeId = modeId;
    this.sessionAgents.set(sessionId, modeId);
  }

  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    const res = await this.sdk.session.command({ path: { id: sessionId }, body: { command: command.split(" ")[0] ?? command, arguments: command.split(" ").slice(1).join(" ") } });
    return res.data;
  }

  async getMessages(sessionId: string): Promise<Array<{ info: Record<string, unknown>; parts: unknown[] }>> {
    if (!this.sdk) return [];
    const res = await this.sdk.session.messages({ path: { id: sessionId } });
    if (res.error || !res.data) return [];
    return res.data as Array<{ info: Record<string, unknown>; parts: unknown[] }>;
  }

  async listSessions(): Promise<OCSession[]> {
    if (!this.sdk) return [];
    const res = await this.sdk.session.list();
    if (res.error || !res.data) return [];
    return res.data as OCSession[];
  }

  // ── Stop / restart ─────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    void this.killCurrent();
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    await this.killCurrent();
  }

  async restart(): Promise<void> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    this.stopped = true; this.restartAttempts = 0;
    await this.killCurrent();
    this.stopped = false;
    await this.connect();
    this.emit("restarted");
  }

  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting opencode serve in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect().then(() => { log.info("opencode serve reconnected"); this.emit("restarted"); })
        .catch((e) => { log.error("opencode serve restart failed:", (e as Error).message); this.maybeRestart(); });
    }, delay);
  }

  private killCurrent(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined; this.sdk = undefined; this.eventLoopActive = false;
    this.failAllPending(new Error("opencode serve is restarting"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => { if (settled) return; settled = true; clearTimeout(hard); resolve(); };
      const hard = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } setTimeout(done, 500); }, 4000);
      proc.once("exit", done);
      try { proc.kill(); } catch { done(); }
    });
  }

  // ── SSE event loop ─────────────────────────────────────────────────────────

  private startEventLoop(): void {
    if (this.eventLoopActive || !this.sdk) return;
    this.eventLoopActive = true;
    void this.runEventLoop();
  }

  private async runEventLoop(): Promise<void> {
    if (!this.sdk) return;
    try {
      const stream = await this.sdk.event.subscribe();
      for await (const evt of stream as unknown as AsyncIterable<{ type: string; properties: unknown }>) {
        if (!this.eventLoopActive) break;
        this.handleEvent(evt.type, evt.properties);
      }
    } catch (e) {
      if (!this.stopped) {
        log.warn("SSE stream closed:", (e as Error).message);
        setTimeout(() => { if (this.eventLoopActive && !this.stopped) this.runEventLoop(); }, 2000);
      }
    }
  }

  private handleEvent(type: string, properties: unknown): void {
    const props = (properties ?? {}) as Record<string, unknown>;
    if (["message.part.updated", "message.updated", "session.updated", "session.status"].includes(type)) {
      this.lastActivityAny = Date.now();
    }
    switch (type) {
      case "message.part.updated": {
        this.onPartUpdated(props as { part: Part; delta?: string });
        break;
      }
      case "session.idle": {
        const sid = props.sessionID as string;
        if (sid) this.resolvePrompt(sid, { stopReason: "end_turn" });
        break;
      }
      case "session.status": {
        const sid = props.sessionID as string;
        const status = props.status as SessionStatus;
        if (sid && status?.type === "idle") this.resolvePrompt(sid, { stopReason: "end_turn" });
        break;
      }
      case "session.error": {
        const sid = props.sessionID as string | undefined;
        const error = props.error as { name?: string; data?: { message?: string } } | undefined;
        if (sid) this.rejectPrompt(sid, new OcError(error?.data?.message ?? error?.name ?? "session error"));
        break;
      }
      case "session.updated": {
        this.emit("notification", "session.updated", props);
        break;
      }
      case "permission.updated": {
        this.onPermissionUpdated(props as unknown as Permission);
        break;
      }
      case "session.created": {
        const info = (props as { info: OCSession }).info;
        if (info?.id && info.parentID) {
          if (!this.subagents.some((s) => s.sessionId === info.id)) {
            this.subagents.push({ sessionId: info.id, sessionName: info.title || info.id.slice(0, 8), status: { type: "running" }, createdAtMs: info.time?.created ?? Date.now() });
            this.emit("subagents", this.subagents.slice(), this.pendingStages);
          }
        }
        this.emit("notification", "session.created", props);
        break;
      }
      case "session.deleted": {
        const info = (props as { info: OCSession }).info;
        if (info?.id) {
          this.subagents = this.subagents.filter((s) => s.sessionId !== info.id);
          this.sessionCwds.delete(info.id); this.sessionModels.delete(info.id); this.sessionAgents.delete(info.id);
        }
        this.emit("notification", "session.deleted", props);
        break;
      }
      case "message.updated": {
        const msgInfo = (props as { info: Record<string, unknown> }).info;
        if (msgInfo?.sessionID && msgInfo.cost !== undefined) {
          const sid = msgInfo.sessionID as string;
          const prev = this.metadata.get(sid);
          this.metadata.set(sid, { ...prev, credits: typeof msgInfo.cost === "number" ? msgInfo.cost : prev?.credits });
        }
        this.emit("notification", "message.updated", props);
        break;
      }
      case "session.compacted": {
        const sid = props.sessionID as string;
        if (sid) { const prev = this.metadata.get(sid); this.metadata.set(sid, { ...prev, effort: "compacted" }); }
        break;
      }
      default:
        this.emit("notification", type, props);
        break;
    }
  }

  private onPartUpdated(data: { part: Part; delta?: string }): void {
    const part = data.part;
    if (!part?.sessionID) return;
    const sessionId = part.sessionID;
    this.lastActivity.set(sessionId, Date.now());

    if (part.type === "text") {
      const text = data.delta ?? (part as TextPart).text;
      if (text) this.emit("session-update", sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      return;
    }
    if (part.type === "reasoning") {
      const text = data.delta ?? (part as { text: string }).text;
      if (text) this.emit("session-update", sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
      return;
    }
    if (part.type === "tool") {
      const tp = part as ToolPart;
      const state = tp.state;
      const kind = this.inferToolKind(tp.tool);
      const status = this.mapToolStatus(state.status);
      const update: SessionUpdate = {
        sessionUpdate: state.status === "pending" ? "tool_call" : "tool_call_update",
        toolCallId: tp.callID,
        title: state.status === "completed" ? (state as ToolStateCompleted).title : tp.tool,
        kind, status,
        rawInput: state.input as Record<string, unknown>,
      };
      if (state.status === "completed") {
        const completed = state as ToolStateCompleted;
        if (completed.metadata) update.content_blocks = this.extractToolContent(completed);
      }
      this.emit("session-update", sessionId, update);
      return;
    }
  }

  private mapToolStatus(status: string): string {
    switch (status) { case "pending": return "pending"; case "running": return "in_progress"; case "completed": return "completed"; case "error": return "failed"; default: return status; }
  }

  private inferToolKind(toolName: string): string {
    const n = toolName.toLowerCase();
    if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "edit";
    if (n.includes("read") || n.includes("list") || n.includes("glob") || n.includes("grep") || n.includes("find")) return "read";
    if (n.includes("bash") || n.includes("exec") || n.includes("run") || n.includes("shell")) return "execute";
    if (n.includes("search") || n.includes("web")) return "search";
    return "execute";
  }

  private extractToolContent(state: ToolStateCompleted): Array<{ type: string; path?: string }> {
    const blocks: Array<{ type: string; path?: string }> = [];
    if (state.metadata) {
      const meta = state.metadata as Record<string, unknown>;
      const fp = meta.filePath ?? meta.path ?? meta.file;
      if (fp) blocks.push({ type: "content", path: String(fp) });
      if (meta.diff || meta.before !== undefined) blocks.push({ type: "diff", path: fp ? String(fp) : undefined });
    }
    return blocks;
  }

  private onPermissionUpdated(perm: Permission): void {
    if (!perm?.id || !perm.type) return; // only new permissions
    if (this.permissionHandler) {
      const params: RequestPermissionParams = {
        sessionId: perm.sessionID,
        toolCall: { toolCallId: perm.callID, title: perm.title, kind: perm.type, rawInput: perm.metadata as Record<string, unknown> },
        options: [{ optionId: "allow", name: "Allow", kind: "allow" }, { optionId: "deny", name: "Deny", kind: "reject" }],
      };
      void this.permissionHandler(params).then((outcome) => {
        if (!this.sdk) return;
        const response = outcome.outcome.outcome === "selected" ? "always" : "reject";
        void this.sdk!.postSessionIdPermissionsPermissionId({ path: { id: perm.sessionID, permissionID: perm.id }, body: { response } }).catch(() => {});
      });
    } else if (this.opts.trustAllTools) {
      this.sdk?.postSessionIdPermissionsPermissionId({ path: { id: perm.sessionID, permissionID: perm.id }, body: { response: "always" } }).catch(() => {});
    }
  }

  // ── Prompt resolution ──────────────────────────────────────────────────────

  private resolvePrompt(sessionId: string, result: PromptResult): void {
    for (const [id, p] of this.pending) { if (p.sessionId === sessionId) { p.cleanup(); this.pending.delete(id); p.resolve(result); } }
  }
  private rejectPrompt(sessionId: string, err: Error): void {
    for (const [id, p] of this.pending) { if (p.sessionId === sessionId) { p.cleanup(); this.pending.delete(id); p.reject(err); } }
  }
  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) { p.cleanup(); p.reject(err); }
    this.pending.clear();
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  currentSubagents(): SubagentInfo[] { return this.subagents.slice(); }
  currentPendingStages(): PendingStage[] { return this.pendingStages.slice(); }
  subagentById(sessionId: string): SubagentInfo | undefined { return this.subagents.find((s) => s.sessionId === sessionId); }
  metadataFor(sessionId: string | undefined): SessionMetadata | undefined { return sessionId ? this.metadata.get(sessionId) : undefined; }
}

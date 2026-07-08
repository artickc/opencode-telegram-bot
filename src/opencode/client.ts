/**
 * OpenCode client — spawns `opencode serve` and communicates via the
 * @opencode-ai/sdk HTTP/SSE API.
 *
 * One server process manages many sessions. Callers create sessions and send
 * prompts; streamed SSE events are translated into `session-update` events
 * keyed by sessionId — the same interface the bot used with OpenCode's ACP.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type {
  EventSessionUpdated,
  Part,
  Permission,
  Session as OCSession,
  SessionStatus,
  TextPart,
  ToolPart,
  ToolStateCompleted,
} from "@opencode-ai/sdk";
import { createLogger } from "../logger.js";
import type {
  ContentBlock,
  InitializeResult,
  PendingStage,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionNotificationParams,
  SessionUpdate,
  SubagentInfo,
  SubagentListUpdate,
} from "./types.js";

const log = createLogger("oc:client");

/** Per-session metadata. */
export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  /** Cost in USD (OpenCode reports this). */
  credits?: number;
}

/** Error that preserves a code and data payload. */
export class OcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "OcError";
  }
}

/** Heuristic: is this prompt failure likely transient and safe to retry? */
const TRANSIENT_RE =
  /internal error|high volume|experiencing|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|dispatch failure|response stream|connection (?:reset|closed|refused|error)|reset by peer|broken pipe|socket hang ?up|econnreset|econnrefused|enotfound|eai_again|etimedout|\b50[234]\b|\b429\b/i;

export function isTransientOcError(err: Error): boolean {
  const code = (err as OcError).code;
  if (typeof code === "number" && [429, 500, 502, 503, 504].includes(code)) return true;
  return TRANSIENT_RE.test(err.message);
}

const CONTEXT_EXHAUSTED_RE =
  /context (?:length|window|limit|size|overflow)|maximum context|input (?:is )?too long|prompt (?:is )?too long|too many (?:input )?tokens|token limit|exceeds? (?:the )?(?:maximum|context|token)|reduce the (?:length|size)|context.{0,24}exhaust/i;

export function isContextExhaustedError(err: Error): boolean {
  return CONTEXT_EXHAUSTED_RE.test(err.message);
}

function shortJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
  } catch {
    return String(v);
  }
}

export interface OcClientOptions {
  opencodePath: string;
  workspace: string;
  trustAllTools: boolean;
  agent?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  /** Reject a prompt only after this long with no streaming activity. */
  promptIdleTimeoutMs?: number;
  /** Absolute safety cap for a single prompt. */
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
  on(e: "subagents", l: (subagents: SubagentInfo[], pending: PendingStage[]) => void): this;
  emit(e: "session-update", sessionId: string, update: SessionUpdate): boolean;
  emit(e: "notification", method: string, params: unknown): boolean;
  emit(e: "exit", code: number | null): boolean;
  emit(e: "restarted"): boolean;
  emit(e: "subagents", subagents: SubagentInfo[], pending: PendingStage[]): boolean;
}

export class OpenCodeClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private sdk?: OpencodeClient;
  private serverUrl?: string;
  private eventStream?: AsyncIterable<{ type: string; properties: unknown }>;
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
  private readonly metadata = new Map<string, SessionMetadata>();
  private subagents: SubagentInfo[] = [];
  private pendingStages: PendingStage[] = [];
  /** Per-session CWD so promptAsync targets the right directory. */
  private readonly sessionCwds = new Map<string, string>();
  /** Per-session model preference (applied at prompt time). */
  private readonly sessionModels = new Map<string, string>();
  /** Per-session agent preference (applied at prompt time). */
  private readonly sessionAgents = new Map<string, string>();
  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  constructor(private readonly opts: OcClientOptions) {
    super();
    this.setMaxListeners(0);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs ?? 6 * 60 * 60_000;
  }

  /** Spawn opencode serve and connect the SDK client. */
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

    // Wait for server to be ready
    this.serverUrl = `http://127.0.0.1:${port}`;
    await this.waitForServer();

    this.sdk = createOpencodeClient({ baseUrl: this.serverUrl, directory: this.opts.workspace });
    this.restartAttempts = 0;
    this.subagents = [];
    this.pendingStages = [];
    this.agentInfo = { name: "opencode", version: "1.0.0" };
    this.capabilities = { loadSession: true, promptCapabilities: { image: true } };

    // Start the SSE event loop
    this.startEventLoop();

    // Discover available agents and models
    await this.discoverAgents();

    log.info(`connected: opencode at ${this.serverUrl}`);
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = require("node:net").createServer();
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
        // Try a simple HTTP request to see if the server is up
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.serverUrl}/session`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timeout);
        if (res.ok || res.status === 401 || res.status === 400) return; // server is responding
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`opencode serve did not become ready within ${maxWaitMs}ms`);
  }

  private async discoverAgents(): Promise<void> {
    if (!this.sdk) return;
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
    try {
      const res = await this.sdk.config.providers();
      if (res.data && Array.isArray(res.data)) {
        // Flatten provider/model into modelId list
        const models: Array<{ modelId: string; name: string; description?: string }> = [];
        for (const p of res.data as Array<Record<string, unknown>>) {
          const providerId = String(p.id ?? "");
          const info = p.info as Record<string, { models?: Record<string, { name?: string }> }> | undefined;
          const modelsMap = info?.models;
          if (modelsMap && typeof modelsMap === "object") {
            for (const [modelId, meta] of Object.entries(modelsMap)) {
              const name = typeof meta === "object" && meta ? String((meta as Record<string, unknown>).name ?? modelId) : modelId;
              models.push({ modelId: `${providerId}/${modelId}`, name });
            }
          }
        }
        this.availableModels = models;
      }
    } catch (e) {
      log.debug("model discovery failed:", (e as Error).message);
    }
  }

  /** Restart the server with exponential backoff after an unexpected exit. */
  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting opencode serve in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          log.info("opencode serve reconnected");
          this.emit("restarted");
        })
        .catch((e) => {
          log.error("opencode serve restart failed:", (e as Error).message);
          this.maybeRestart();
        });
    }, delay);
  }

  get supportsLoadSession(): boolean {
    return true; // OpenCode sessions persist server-side
  }

  hasInflightPrompt(): boolean {
    return this.pending.size > 0;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Create a new session. */
  async newSession(cwd: string): Promise<string> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    const res = await this.sdk.session.create({
      query: { directory: cwd },
      body: {},
    });
    if (res.error || !res.data) {
      throw new OcError(`session.create failed`, res.response?.status);
    }
    this.sessionCwds.set(res.data.id, cwd);
    return res.data.id;
  }

  /** Load (resume) an existing session. In OpenCode, sessions persist server-side
   *  so this is effectively a no-op — the session is already accessible. */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    // Verify the session exists
    const res = await this.sdk.session.get({
      path: { id: sessionId },
      query: { directory: cwd },
    });
    if (res.error || !res.data) {
      throw new OcError(`session.load failed`, res.response?.status);
    }
  }

  hasMode(id: string): boolean {
    return this.availableModes.some((m) => m.id === id);
  }

  hasModel(id: string): boolean {
    return id === "auto" || this.availableModels.some((m) => m.modelId === id || m.modelId.endsWith(`/${id}`));
  }

  /**
   * Send a prompt asynchronously and track its completion via SSE events.
   * Resolves when the turn ends (session becomes idle).
   */
  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      if (!this.sdk) {
        reject(new Error("opencode serve is not running"));
        return;
      }
      const promptId = `p-${this.nextId++}`;
      const start = Date.now();
      this.lastActivity.set(sessionId, start);

      // Build parts from ContentBlocks
      const parts = content.map((cb) => {
        if (cb.type === "text") {
          return { type: "text" as const, text: cb.text ?? "" };
        }
        if (cb.type === "image" && cb.data) {
          return { type: "file" as const, mime: cb.mimeType ?? "image/png", url: `data:${cb.mimeType};base64,${cb.data}` };
        }
        return { type: "text" as const, text: cb.text ?? JSON.stringify(cb) };
      });

      const watch = setInterval(() => {
        const last = Math.max(this.lastActivity.get(sessionId) ?? start, this.lastActivityAny);
        const idle = Date.now() - last;
        const total = Date.now() - start;
        if (total > this.promptMaxMs) {
          this.pending.delete(promptId);
          clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          this.pending.delete(promptId);
          clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);

      this.pending.set(promptId, {
        resolve: (v) => resolve(v),
        reject,
        cleanup: () => clearInterval(watch),
        sessionId,
      });

      // Get agent/model preferences
      const cwd = this.sessionCwds.get(sessionId) ?? this.opts.workspace;
      const sessionModel = this.sessionModels.get(sessionId);
      const sessionAgent = this.sessionAgents.get(sessionId) ?? this.opts.agent;
      const body: {
        parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      } = { parts };
      if (sessionAgent) body.agent = sessionAgent;
      if (sessionModel) {
        const [providerID, ...modelParts] = sessionModel.split("/");
        if (providerID && modelParts.length) {
          body.model = { providerID, modelID: modelParts.join("/") };
        }
      }

      this.sdk!
        .session.promptAsync({
          path: { id: sessionId },
          query: { directory: cwd },
          body,
        })
        .then((res) => {
          if (res.error) {
            this.pending.delete(promptId);
            clearInterval(watch);
            reject(new OcError(`prompt failed`, res.response?.status));
          }
          // Success: the SSE event loop will detect session idle and resolve.
        })
        .catch((err) => {
          this.pending.delete(promptId);
          clearInterval(watch);
          reject(err as Error);
        });
    });
  }

  /** Abort the current turn for a session. */
  async cancel(sessionId: string): Promise<void> {
    if (!this.sdk) return;
    try {
      await this.sdk.session.abort({ path: { id: sessionId } });
    } catch (e) {
      log.debug("abort failed:", (e as Error).message);
    }
  }

  /** Set model for a session (not directly supported per-session in OpenCode,
   *  but we track it for display). */
  /** Set model for a session. Stored per-session and applied at prompt time. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    this.sessionModels.set(sessionId, modelId);
  }

  /** Set agent for a session. Stored per-session and applied at prompt time. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.currentModeId = modeId;
    this.sessionAgents.set(sessionId, modeId);
  }

  /** Execute an OpenCode command. */
  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    if (!this.sdk) throw new Error("opencode serve is not running");
    const res = await this.sdk.session.command({
      path: { id: sessionId },
      body: { command: command.split(" ")[0] ?? command, arguments: command.split(" ").slice(1).join(" ") },
    });
    return res.data;
  }

  /** Get messages for a session (replaces the history parser). */
  async getMessages(sessionId: string): Promise<Array<{ info: Record<string, unknown>; parts: unknown[] }>> {
    if (!this.sdk) return [];
    const res = await this.sdk.session.messages({ path: { id: sessionId } });
    if (res.error || !res.data) return [];
    return res.data as Array<{ info: Record<string, unknown>; parts: unknown[] }>;
  }

  /** List all sessions. */
  async listSessions(): Promise<OCSession[]> {
    if (!this.sdk) return [];
    const res = await this.sdk.session.list();
    if (res.error || !res.data) return [];
    return res.data as OCSession[];
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    void this.killCurrent();
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    await this.killCurrent();
  }

  async restart(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopped = true;
    this.restartAttempts = 0;
    await this.killCurrent();
    this.stopped = false;
    await this.connect();
    this.emit("restarted");
  }

  private killCurrent(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.sdk = undefined;
    this.eventLoopActive = false;
    this.failAllPending(new Error("opencode serve is restarting"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        resolve();
      };
      const hard = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        setTimeout(done, 500);
      }, 4000);
      proc.once("exit", done);
      try {
        proc.kill();
      } catch {
        done();
      }
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
      this.eventStream = stream as unknown as AsyncIterable<{ type: string; properties: unknown }>;

      for await (const evt of this.eventStream) {
        if (!this.eventLoopActive) break;
        this.handleEvent(evt.type, evt.properties);
      }
    } catch (e) {
      if (!this.stopped) {
        log.warn("SSE stream closed:", (e as Error).message);
        // Reconnect after a short delay
        setTimeout(() => {
          if (this.eventLoopActive && !this.stopped) this.runEventLoop();
        }, 2000);
      }
    }
  }

  private handleEvent(type: string, properties: unknown): void {
    const props = (properties ?? {}) as Record<string, unknown>;

    // Track activity for any agent-work event
    if (
      type === "message.part.updated" ||
      type === "message.updated" ||
      type === "session.updated" ||
      type === "session.status"
    ) {
      this.lastActivityAny = Date.now();
    }

    switch (type) {
      case "message.part.updated": {
        this.onPartUpdated(props as { part: Part; delta?: string });
        break;
      }
      case "session.idle": {
        const sessionId = props.sessionID as string;
        if (sessionId) this.resolvePrompt(sessionId, { stopReason: "end_turn" });
        break;
      }
      case "session.status": {
        const sessionId = props.sessionID as string;
        const status = props.status as SessionStatus;
        if (sessionId && status?.type === "idle") {
          this.resolvePrompt(sessionId, { stopReason: "end_turn" });
        }
        break;
      }
      case "session.error": {
        const sessionId = props.sessionID as string | undefined;
        const error = props.error as { name?: string; data?: { message?: string } } | undefined;
        if (sessionId) {
          const msg = error?.data?.message ?? error?.name ?? "session error";
          this.rejectPrompt(sessionId, new OcError(msg));
        }
        break;
      }
      case "session.updated": {
        const info = (props as { info: OCSession }).info;
        if (info?.id) {
          // Extract cost/summary info if present
          if (info.summary) {
            const prev = this.metadata.get(info.id);
            this.metadata.set(info.id, {
              ...prev,
              effort: info.summary as unknown as string | undefined,
            });
          }
          this.emit("notification", "session.updated", props);
        }
        break;
      }
      case "permission.updated": {
        const perm = props as unknown as Permission;
        this.onPermissionUpdated(perm);
        break;
      }
      case "session.created": {
        // Track child/subagent sessions (those with a parentID)
        const info = (props as { info: OCSession }).info;
        if (info?.id && info.parentID) {
          const subInfo: SubagentInfo = {
            sessionId: info.id,
            sessionName: info.title || info.id.slice(0, 8),
            status: { type: "running" },
            createdAtMs: info.time?.created ?? Date.now(),
          };
          if (!this.subagents.some((s) => s.sessionId === info.id)) {
            this.subagents.push(subInfo);
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
          this.sessionCwds.delete(info.id);
          this.sessionModels.delete(info.id);
          this.sessionAgents.delete(info.id);
          if (this.subagents.length > 0 || this.pendingStages.length > 0) {
            this.emit("subagents", this.subagents.slice(), this.pendingStages);
          }
        }
        this.emit("notification", "session.deleted", props);
        break;
      }
      case "message.updated": {
        // Extract cost/tokens from assistant message completion
        const msgInfo = (props as { info: Record<string, unknown> }).info;
        if (msgInfo?.sessionID && (msgInfo.cost !== undefined || msgInfo.finish)) {
          const sid = msgInfo.sessionID as string;
          const prev = this.metadata.get(sid);
          this.metadata.set(sid, {
            ...prev,
            credits: typeof msgInfo.cost === "number" ? msgInfo.cost : prev?.credits,
          });
        }
        this.emit("notification", "message.updated", props);
        break;
      }
      case "session.compacted": {
        const sessionId = props.sessionID as string;
        if (sessionId) {
          this.metadata.set(sessionId, {
            ...this.metadata.get(sessionId),
            effort: "compacted",
          });
        }
        break;
      }
      default:
        // Forward unhandled events as generic notifications
        this.emit("notification", type, props);
        break;
    }
  }

  /** Translate an OpenCode Part update into a bot session-update event. */
  private onPartUpdated(data: { part: Part; delta?: string }): void {
    const part = data.part;
    if (!part?.sessionID) return;
    const sessionId = part.sessionID;
    this.lastActivity.set(sessionId, Date.now());

    // Text part → agent_message_chunk
    if (part.type === "text") {
      const tp = part as TextPart;
      const text = data.delta ?? tp.text;
      if (text) {
        const update: SessionUpdate = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        };
        this.emit("session-update", sessionId, update);
      }
      return;
    }

    // Reasoning part → agent_thought_chunk
    if (part.type === "reasoning") {
      const rp = part as { text: string; type: string };
      const text = data.delta ?? rp.text;
      if (text) {
        const update: SessionUpdate = {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        };
        this.emit("session-update", sessionId, update);
      }
      return;
    }

    // Tool part → tool_call or tool_call_update
    if (part.type === "tool") {
      const tp = part as ToolPart;
      const state = tp.state;
      const kind = this.inferToolKind(tp.tool);
      const status = this.mapToolStatus(state.status);
      const update: SessionUpdate = {
        sessionUpdate: state.status === "pending" ? "tool_call" : "tool_call_update",
        toolCallId: tp.callID,
        title: state.status === "completed" ? (state as ToolStateCompleted).title : `${tp.tool}`,
        kind,
        status,
        rawInput: state.input as Record<string, unknown>,
      };
      // For completed tools with file ops, include content_blocks
      if (state.status === "completed") {
        const completed = state as ToolStateCompleted;
        if (completed.metadata) {
          update.content_blocks = this.extractToolContent(completed);
        }
      }
      this.emit("session-update", sessionId, update);
      return;
    }

    // Step-start → plan event
    if (part.type === "step-start") {
      // Forward as a plan notification
      this.emit("notification", "step-start", { sessionId, part });
      return;
    }
  }

  /** Map OpenCode tool status to the bot's status vocabulary. */
  private mapToolStatus(status: string): "pending" | "in_progress" | "completed" | "failed" | string {
    switch (status) {
      case "pending":
        return "pending";
      case "running":
        return "in_progress";
      case "completed":
        return "completed";
      case "error":
        return "failed";
      default:
        return status;
    }
  }

  /** Infer the tool "kind" from the tool name for display. */
  private inferToolKind(toolName: string): string {
    const name = toolName.toLowerCase();
    if (name.includes("edit") || name.includes("write") || name.includes("patch")) return "edit";
    if (name.includes("read") || name.includes("list") || name.includes("glob") || name.includes("grep") || name.includes("find"))
      return "read";
    if (name.includes("bash") || name.includes("exec") || name.includes("run") || name.includes("shell")) return "execute";
    if (name.includes("search") || name.includes("web")) return "search";
    return "execute";
  }

  /** Extract tool content blocks (diffs, file paths) from a completed tool. */
  private extractToolContent(state: ToolStateCompleted): Array<{ type: string; path?: string }> {
    const blocks: Array<{ type: string; path?: string }> = [];
    if (state.metadata) {
      const meta = state.metadata as Record<string, unknown>;
      // File path from tool metadata
      const filePath = (meta.filePath ?? meta.path ?? meta.file) as string | undefined;
      if (filePath) {
        blocks.push({ type: "content", path: filePath });
      }
      // Diff content
      const diff = (meta.diff ?? meta.before !== undefined) as string | undefined;
      if (diff) {
        blocks.push({ type: "diff", path: filePath });
      }
    }
    return blocks;
  }

  /** Handle a permission event from OpenCode. */
  private onPermissionUpdated(perm: Permission): void {
    if (!perm?.id) return;
    // Only act on NEW permission requests (type field is set, no response yet).
    // OpenCode re-emits permission.updated when a response arrives, but with
    // a different shape — skip those.
    if (!perm.type) return;
    if (this.permissionHandler) {
      const params: RequestPermissionParams = {
        sessionId: perm.sessionID,
        toolCall: {
          toolCallId: perm.callID,
          title: perm.title,
          kind: perm.type,
          rawInput: perm.metadata as Record<string, unknown>,
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow" },
          { optionId: "deny", name: "Deny", kind: "reject" },
        ],
      };
      void this.permissionHandler(params).then((outcome) => {
        if (!this.sdk) return;
        const response = outcome.outcome.outcome === "selected" ? "always" : "reject";
        void this.sdk!.postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.id },
          body: { response },
        }).catch(() => {});
      });
    } else if (this.opts.trustAllTools) {
      // Auto-approve in trust-all mode
      this.sdk?.postSessionIdPermissionsPermissionId({
        path: { id: perm.sessionID, permissionID: perm.id },
        body: { response: "always" },
      }).catch(() => {});
    }
  }

  /** Resolve all pending prompts for a session. */
  private resolvePrompt(sessionId: string, result: PromptResult): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        p.cleanup();
        this.pending.delete(id);
        p.resolve(result);
      }
    }
  }

  /** Reject all pending prompts for a session. */
  private rejectPrompt(sessionId: string, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        p.cleanup();
        this.pending.delete(id);
        p.reject(err);
      }
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  currentSubagents(): SubagentInfo[] {
    return this.subagents.slice();
  }

  currentPendingStages(): PendingStage[] {
    return this.pendingStages.slice();
  }

  subagentById(sessionId: string): SubagentInfo | undefined {
    return this.subagents.find((s) => s.sessionId === sessionId);
  }

  metadataFor(sessionId: string | undefined): SessionMetadata | undefined {
    return sessionId ? this.metadata.get(sessionId) : undefined;
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Re-export error helpers under the names expected by session-runtime. */
export const isTransientAcpError = isTransientOcError;

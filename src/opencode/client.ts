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

/** Events emitted in bulk on connect / config changes — not useful to forward. */
const NOISY_EVENTS = new Set([
  "server.connected",
  "server.heartbeat",
  "plugin.added",
  "plugin.removed",
  "catalog.updated",
  "integration.updated",
  "reference.updated",
  "lsp.updated",
  "mcp.tools.changed",
  "file.watcher.updated",
  "vcs.branch.updated",
]);
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
  /** Per-directory SSE subscriptions: directory → active flag. */
  private readonly eventStreams = new Map<string, boolean>();
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

    const useShell = process.platform === "win32" && !this.opts.opencodePath.includes("\\") && !this.opts.opencodePath.includes("/");
    const proc = spawn(this.opts.opencodePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env: { ...process.env },
      shell: useShell,
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
      this.sdk = createOpencodeClient({ baseUrl: this.serverUrl });
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
    if (!this.serverUrl) throw new Error("opencode serve is not running");
    const res = await fetch(`${this.serverUrl}/session?directory=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!res.ok) throw new OcError("session.create failed", res.status);
    const data = await res.json() as { id: string };
    this.sessionCwds.set(data.id, cwd);
    this.subscribeDirectory(cwd);
    return data.id;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.serverUrl) throw new Error("opencode serve is not running");
    this.sessionCwds.set(sessionId, cwd);
    this.subscribeDirectory(cwd);
    const res = await fetch(`${this.serverUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(cwd)}`);
    if (!res.ok) throw new OcError("session.load failed", res.status);
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

      // Use raw HTTP like the reference bot - no SDK wrapping
      const cwd = this.sessionCwds.get(sessionId) ?? this.opts.workspace;
      const sessionModel = this.sessionModels.get(sessionId);
      const sessionAgent = this.sessionAgents.get(sessionId) ?? this.opts.agent;
      const body: Record<string, unknown> = { parts };
      if (sessionAgent) body.agent = sessionAgent;
      if (sessionModel && sessionModel.indexOf("/") > 0) {
        body.model = { providerID: sessionModel.slice(0, sessionModel.indexOf("/")), modelID: sessionModel.slice(sessionModel.indexOf("/") + 1) };
      }
      const promptUrl = `${this.serverUrl}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(cwd)}`;
      fetch(promptUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((res) => {
          if (!res.ok) { this.pending.delete(promptId); clearInterval(watch); reject(new OcError(`prompt_async HTTP ${res.status}`, res.status)); }
          else log.debug(`promptAsync ok on ${sessionId.slice(0, 12)}, awaiting SSE resolution`);
        })
        .catch((err) => { this.pending.delete(promptId); clearInterval(watch); log.debug(`promptAsync FAILED: ${ (err as Error).message }`); reject(err as Error); });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.serverUrl) return;
    try {
      await fetch(`${this.serverUrl}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    } catch (e) { log.debug("abort failed:", (e as Error).message); }
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

  /**
   * Query the live server for ALL sessions it knows about + their status.
   * Returns a map of sessionId → live session metadata. The bot's `opencode
   * serve` instance shares storage with all other OpenCode processes on this
   * machine (same `~/.local/share/opencode/` dir), so `session.list()` returns
   * every session, not just the bot's own.
   */
  async getLiveSessions(): Promise<Map<string, {
    title: string;
    directory: string;
    status: "idle" | "busy" | "retry";
    updatedAt: number;
    createdAt: number;
  }>> {
    if (!this.sdk) return new Map();
    try {
      const [listRes, statusRes] = await Promise.all([
        this.sdk.session.list(),
        this.sdk.session.status(),
      ]);
      if (listRes.error || !listRes.data) return new Map();

      const statusMap = (statusRes.data ?? {}) as Record<string, SessionStatus>;
      const sessions = listRes.data as OCSession[];
      const result = new Map<string, {
        title: string;
        directory: string;
        status: "idle" | "busy" | "retry";
        updatedAt: number;
        createdAt: number;
      }>();

      for (const s of sessions) {
        const st = statusMap[s.id];
        const statusType = st?.type ?? "idle";
        result.set(s.id, {
          title: s.title || s.id.slice(0, 8),
          directory: s.directory || "",
          status: statusType as "idle" | "busy" | "retry",
          updatedAt: s.time?.updated ?? 0,
          createdAt: s.time?.created ?? 0,
        });
      }
      return result;
    } catch (e) {
      log.debug("getLiveSessions failed:", (e as Error).message);
      return new Map();
    }
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
    this.proc = undefined; this.sdk = undefined; this.eventStreams.clear();
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

  // ── SSE event loop (per-directory subscriptions) ──────────────────────────
  //
  // OpenCode's `/event` endpoint REQUIRES a `directory` query param to scope
  // which workspace's events are streamed. Without it only server heartbeats
  // arrive and prompts never resolve. We maintain one persistent SSE connection
  // per unique session cwd, auto-reconnecting on drop.

  private startEventLoop(): void {
    // Always subscribe to the default workspace so background/launch events flow.
    void this.subscribeDirectory(this.opts.workspace);
  }

  /** Ensure we have (or will have) an SSE subscription for the given directory. */
  private subscribeDirectory(directory: string): void {
    if (!directory || this.eventStreams.has(directory)) return;
    this.eventStreams.set(directory, true);
    void this.runEventLoop(directory);
  }

  private async runEventLoop(directory: string): Promise<void> {
    if (!this.serverUrl) return;
    const tag = `[oc] SSE(${directory})`;
    try {
      const url = `${this.serverUrl}/event?directory=${encodeURIComponent(directory)}`;
      log.info(`connecting ${url}`);
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      log.info(`stream connected for ${directory}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = "";
      let evtCount = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Stream was cancelled (client stopping) — stop reading.
        if (!this.eventStreams.get(directory)) { reader.cancel(); break; }
        buffer += dec.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          try {
            const evt = JSON.parse(dataLines.join("\n"));
            evtCount++;
            if (evtCount <= 3) log.debug(`${tag} event #${evtCount}: ${evt.type}`);
            this.handleEvent(evt.type, evt.properties);
          } catch { /* not JSON */ }
        }
      }
      log.debug(`${tag} stream ended after ${evtCount} events`);
    } catch (e) {
      log.debug(`${tag} error: ${(e as Error).message}`);
    }
    // Auto-reconnect with backoff unless we're shutting down or the directory
    // was explicitly unsubscribed.
    if (this.stopped || !this.eventStreams.get(directory)) return;
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(this.restartAttempts, 4));
    setTimeout(() => {
      if (!this.stopped && this.eventStreams.get(directory)) void this.runEventLoop(directory);
    }, delay);
  }

  private firstEventSeen = false;

  /**
   * Per-part accumulated text we've already streamed, keyed by part id.
   * OpenCode's `message.part.updated` carries a *growing snapshot* of the
   * part's full text on each tick (not a raw delta), so we emit only the newly
   * appended suffix — otherwise the streamer, which appends chunks, would
   * duplicate the whole response on every update.
   */
  private readonly partText = new Map<string, string>();
  /**
   * messageID → role, learned from `message.updated` (which always precedes its
   * parts). Lets us skip the user's own prompt, which OpenCode also emits as a
   * `message.part.updated` text part — without this the bot streams your prompt
   * back as if it were the agent's reply.
   */
  private readonly msgRole = new Map<string, "user" | "assistant">();
  /** Part/message ids seen per session, so turn state is released on idle. */
  private readonly turnParts = new Map<string, Set<string>>();
  private readonly turnMsgs = new Map<string, Set<string>>();
  /**
   * Text/reasoning parts seen BEFORE their message's role was known — this
   * happens out-of-order on RESUMED sessions. Keyed messageID → (partID →
   * latest snapshot). Flushed as agent output when `message.updated` resolves
   * the role to "assistant", or discarded when it resolves to "user". Without
   * this, an out-of-order user part would be echoed, or (with a naive skip) the
   * assistant reply would be dropped — see accomplish-ai/coworker's
   * OpenCodeAdapter, which carries a regression test for exactly this case.
   */
  private readonly pendingParts = new Map<string, Map<string, { sessionId: string; reasoning: boolean; text: string }>>();

  private handleEvent(type: string, properties: unknown): void {
    const props = (properties ?? {}) as Record<string, unknown>;
    if (!this.firstEventSeen) {
      this.firstEventSeen = true;
      log.info(`first SSE event received: ${type}`);
    }
    if (["message.part.updated", "message.part.delta", "message.updated", "session.updated", "session.status"].includes(type)) {
      this.lastActivityAny = Date.now();
    }
    switch (type) {
      case "message.part.updated": {
        this.onPartUpdated(props as { part: Part; delta?: string });
        break;
      }
      case "message.part.delta": {
        // Live streaming is driven entirely by `message.part.updated` snapshots
        // (see onPartUpdated), which carry the full growing text. The raw delta
        // is used only as a keep-alive signal here so the idle-timeout doesn't
        // fire mid-stream — emitting it would double the rendered response.
        const sid = props.sessionID as string | undefined;
        if (sid) this.lastActivity.set(sid, Date.now());
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
          this.clearTurnState(info.id);
        }
        this.emit("notification", "session.deleted", props);
        break;
      }
      case "message.updated": {
        const msgInfo = (props as { info: Record<string, unknown> }).info;
        if (msgInfo?.id && (msgInfo.role === "user" || msgInfo.role === "assistant")) {
          const mid = msgInfo.id as string;
          const mrole = msgInfo.role as "user" | "assistant";
          this.msgRole.set(mid, mrole);
          if (msgInfo.sessionID) {
            const sid = msgInfo.sessionID as string;
            const set = this.turnMsgs.get(sid) ?? new Set<string>();
            set.add(mid);
            this.turnMsgs.set(sid, set);
          }
          this.flushPending(mid, mrole);
        }
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
      default: {
        // Ignore high-volume housekeeping events that would otherwise spam
        // the notification channel.
        if (NOISY_EVENTS.has(type)) break;
        this.emit("notification", type, props);
        break;
      }
    }
  }

  private onPartUpdated(data: { part: Part; delta?: string }): void {
    const part = data.part;
    if (!part?.sessionID) return;
    const sessionId = part.sessionID;
    this.lastActivity.set(sessionId, Date.now());

    // OpenCode emits a `message.part.updated` for the *user's* message too, so
    // we must not stream it back as agent output. Normally `message.updated`
    // (which sets the role) precedes a message's parts; but on RESUMED sessions
    // parts can arrive first, so the role may be unknown here:
    //   • role "user"      → skip (the prompt echo),
    //   • role "assistant" → stream now,
    //   • role unknown     → buffer until message.updated resolves the role.
    const messageID = (part as { messageID?: string }).messageID;
    const role = messageID ? this.msgRole.get(messageID) : undefined;
    if (role === "user") return;

    if (part.type === "text" || part.type === "reasoning") {
      if ((part as TextPart).ignored) return;
      const full = (part as TextPart | { text?: string }).text ?? "";
      const reasoning = part.type === "reasoning";
      if (role === undefined && messageID) {
        let m = this.pendingParts.get(messageID);
        if (!m) { m = new Map(); this.pendingParts.set(messageID, m); }
        m.set(part.id, { sessionId, reasoning, text: full });
        return;
      }
      this.emitTextGrowth(sessionId, part.id, full, reasoning);
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

  /**
   * Given the full growing snapshot of a text/reasoning part, return only the
   * newly-appended suffix (what hasn't been streamed yet) and remember it.
   * Handles the rare wholesale-replacement case by re-emitting from scratch.
   */
  private textGrowth(sessionId: string, partId: string, full: string): string {
    const prev = this.partText.get(partId) ?? "";
    if (full === prev) return "";
    const chunk = full.startsWith(prev) ? full.slice(prev.length) : full;
    this.partText.set(partId, full);
    const set = this.turnParts.get(sessionId) ?? new Set<string>();
    set.add(partId);
    this.turnParts.set(sessionId, set);
    return chunk;
  }

  /** Emit the newly-appended text of a part as an agent message/thought chunk. */
  private emitTextGrowth(sessionId: string, partId: string, full: string, reasoning: boolean): void {
    const chunk = this.textGrowth(sessionId, partId, full);
    if (!chunk) return;
    const kind = reasoning ? "agent_thought_chunk" : "agent_message_chunk";
    this.emit("session-update", sessionId, { sessionUpdate: kind, content: { type: "text", text: chunk } });
  }

  /** Once a message's role is known, flush (assistant) or discard (user) any
   *  parts that arrived before it. Insertion order preserves arrival order. */
  private flushPending(messageID: string, role: "user" | "assistant"): void {
    const m = this.pendingParts.get(messageID);
    if (!m) return;
    this.pendingParts.delete(messageID);
    if (role !== "assistant") return; // user parts: never echo
    for (const [partId, p] of m) this.emitTextGrowth(p.sessionId, partId, p.text, p.reasoning);
  }

  /** At turn end, flush any still-unresolved parts for the session as assistant
   *  output. By idle the user message's role is long known, so leftovers are
   *  assistant content whose `message.updated` was missed — flush, never drop. */
  private flushPendingForSession(sessionId: string): void {
    for (const [messageID, m] of this.pendingParts) {
      const relevant = [...m.entries()].filter(([, p]) => p.sessionId === sessionId);
      if (relevant.length === 0) continue;
      for (const [partId, p] of relevant) this.emitTextGrowth(p.sessionId, partId, p.text, p.reasoning);
      this.pendingParts.delete(messageID);
    }
  }

  /** Release per-turn streaming state for a session (part/message tracking). */
  private clearTurnState(sessionId: string): void {
    const parts = this.turnParts.get(sessionId);
    if (parts) { for (const pid of parts) this.partText.delete(pid); this.turnParts.delete(sessionId); }
    const msgs = this.turnMsgs.get(sessionId);
    if (msgs) { for (const mid of msgs) this.msgRole.delete(mid); this.turnMsgs.delete(sessionId); }
    for (const [messageID, m] of this.pendingParts) {
      for (const p of m.values()) { if (p.sessionId === sessionId) { this.pendingParts.delete(messageID); break; } }
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
    this.flushPendingForSession(sessionId);
    for (const [id, p] of this.pending) { if (p.sessionId === sessionId) { p.cleanup(); this.pending.delete(id); log.debug(`prompt ${id} resolved: ${result.stopReason}`); p.resolve(result); } }
    this.clearTurnState(sessionId);
  }
  private rejectPrompt(sessionId: string, err: Error): void {
    for (const [id, p] of this.pending) { if (p.sessionId === sessionId) { p.cleanup(); this.pending.delete(id); p.reject(err); } }
    this.clearTurnState(sessionId);
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

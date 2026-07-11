/**
 * OpenCode client — spawns `opencode acp` and speaks JSON-RPC 2.0 over stdio
 * (Agent Client Protocol). This replaces the fragile HTTP + SSE transport:
 * session/update notifications and the blocking session/prompt response travel
 * on the same reliable pipe as the agent process, so mid-turn freezes from
 * dropped SSE / wrong-directory event scopes cannot happen.
 *
 * Public surface matches the previous HTTP client so session-runtime / handlers
 * keep working unchanged.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
} from "./types.js";
import { JsonRpcTransport, type JsonRpcMessage } from "./transport.js";

const log = createLogger("oc:client");

export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  credits?: number;
  totalTokens?: number;
}

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

const TRANSIENT_CODES = new Set([-32603, -32500, -32000, 500, 502, 503, 504, 429]);
const TRANSIENT_RE =
  /internal error|high volume|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|connection (?:reset|closed|refused)|reset by peer|broken pipe|socket hang ?up|econnreset|econnrefused|etimedout|\b50[234]\b|\b429\b|streaming error|disposed object|networkstream|cannot access a disposed|stream closed mid|unexpected eof|connection aborted|forcibly closed/i;
const CONTEXT_EXHAUSTED_RE =
  /context (?:length|window|limit|overflow)|maximum context|input (?:is )?too long|too many (?:input )?tokens|token limit|exceeds? (?:the )?(?:maximum|context|token)|context.{0,24}exhaust/i;

export function isTransientOcError(err: Error): boolean {
  const code = (err as OcError).code;
  if (typeof code === "number" && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_RE.test(err.message);
}
export function isContextExhaustedError(err: Error): boolean {
  return CONTEXT_EXHAUSTED_RE.test(err.message);
}
/** Compat alias used by session-runtime. */
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

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  method: string;
  sessionId?: string;
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
  private transport?: JsonRpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly timeout: number;
  private readonly promptIdleMs: number;
  private readonly promptMaxMs: number;
  private readonly lastActivity = new Map<string, number>();
  private lastActivityAny = 0;
  private stopped = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private readonly sessionCwds = new Map<string, string>();
  private readonly running = new Set<string>();

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

  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  constructor(private readonly opts: OcClientOptions) {
    super();
    this.setMaxListeners(0);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs ?? 6 * 60 * 60_000;
    // Do NOT pre-seed currentModeId from opts.agent — that made hasMode("Artur")
    // true before discovery and let applySessionPrefs call setMode with a phantom
    // id, after which session/prompt returned empty end_turn.
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const args = ["acp"];
    log.info(`spawning: ${this.opts.opencodePath} ${args.join(" ")}`);

    // On Windows, bare names on PATH need shell; absolute .exe does not.
    const useShell =
      process.platform === "win32" &&
      !this.opts.opencodePath.includes("\\") &&
      !this.opts.opencodePath.includes("/");

    const proc = spawn(this.opts.opencodePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env: { ...process.env },
      shell: useShell,
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      log.warn(`opencode acp exited (code ${code})`);
      this.failAllPending(new Error(`opencode acp exited (code ${code})`));
      this.emit("exit", code);
      this.maybeRestart();
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      log.error("failed to spawn opencode acp:", err.message);
      this.failAllPending(err);
    });

    this.transport = new JsonRpcTransport(proc);
    this.transport.on("message", (m: JsonRpcMessage) => this.onMessage(m));

    // session/new can take a long time the first time (skills/MCP boot) — use a
    // longer timeout for initialize + session methods than generic RPCs.
    const init = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "opencode-telegram-bot", version: "1.0.5" },
      },
      60_000,
    )) as InitializeResult & {
      authMethods?: Array<{ id: string; name?: string }>;
      agentInfo?: { name?: string; version?: string };
      agentCapabilities?: InitializeResult["agentCapabilities"];
    };

    this.agentInfo = init.agentInfo ?? { name: "OpenCode" };
    this.capabilities = init.agentCapabilities;
    this.restartAttempts = 0;
    this.subagents = [];
    this.pendingStages = [];

    // OpenCode advertises `opencode-login` which uses the cached CLI login —
    // authenticate is a no-op success when already logged in.
    const methods = init.authMethods ?? [];
    const methodId = methods.find((m) => m.id === "opencode-login")?.id ?? methods[0]?.id;
    if (methodId) {
      try {
        await this.request("authenticate", { methodId }, 30_000);
        log.info(`authenticated via ${methodId}`);
      } catch (e) {
        log.warn(`authenticate (${methodId}) failed: ${(e as Error).message}`);
      }
    }

    log.info(`connected: ${this.agentInfo?.name ?? "OpenCode"} ${this.agentInfo?.version ?? ""} (ACP/stdio)`.trim());
  }

  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting opencode acp in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          log.info("opencode acp reconnected");
          this.emit("restarted");
        })
        .catch((e) => {
          log.error("opencode acp restart failed:", (e as Error).message);
          this.maybeRestart();
        });
    }, delay);
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
    this.transport = undefined;
    this.failAllPending(new Error("opencode acp is restarting"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
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

  // ── Session management ─────────────────────────────────────────────────────

  get supportsLoadSession(): boolean {
    return Boolean(this.capabilities?.loadSession ?? true);
  }

  hasInflightPrompt(): boolean {
    for (const p of this.pending.values()) if (p.method === "session/prompt") return true;
    return false;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  hasMode(id: string): boolean {
    if (!id) return false;
    // Only trust modes OpenCode actually advertised. Matching a stale
    // currentModeId from constructor opts (e.g. OPENCODE_AGENT=Artur) made
    // hasMode() return true for phantom ids and setMode() blanked later turns.
    if (this.availableModes.length > 0) {
      return this.availableModes.some((m) => m.id === id);
    }
    return id === this.currentModeId;
  }

  hasModel(id: string): boolean {
    if (!id) return false;
    if (id === "auto") return true;
    return this.resolveModelId(id) !== undefined;
  }

  /**
   * Expand a short alias ("think") to a full provider/model id
   * ("vibeproxy/vibe/think"). Prefer exact match, then unique suffix match.
   */
  resolveModelId(id: string): string | undefined {
    if (!id) return undefined;
    if (id === "auto") return id;
    const exact = this.availableModels.find((m) => m.modelId === id);
    if (exact) return exact.modelId;
    if (id.includes("/")) return undefined; // full id not in list
    const suffix = this.availableModels.filter(
      (m) => m.modelId.endsWith(`/${id}`) || m.modelId.split("/").pop() === id,
    );
    // Prefer the session's current provider family when several match.
    if (this.currentModelId) {
      const pref = this.currentModelId.split("/")[0];
      const sameFamily = suffix.find((m) => m.modelId.startsWith(`${pref}/`));
      if (sameFamily) return sameFamily.modelId;
    }
    if (suffix.length === 1) return suffix[0]!.modelId;
    // Ambiguous bare alias with many matches — refuse rather than guess wrong.
    if (suffix.length > 1) {
      // If current model already ends with the alias, keep it.
      if (this.currentModelId?.endsWith(`/${id}`) || this.currentModelId?.endsWith(id)) {
        return this.currentModelId;
      }
      return suffix[0]!.modelId; // stable first match after discovery sort
    }
    return undefined;
  }

  async newSession(cwd: string): Promise<string> {
    // First project open can take 10–30s while skills/MCP boot.
    const res = (await this.request(
      "session/new",
      { cwd, mcpServers: [] },
      120_000,
    )) as {
      sessionId: string;
      configOptions?: Array<{
        id: string;
        currentValue?: string;
        options?: Array<{ value: string; name?: string; description?: string }>;
      }>;
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
    };
    this.parseSessionExtras(res);
    this.sessionCwds.set(res.sessionId, cwd);
    return res.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const res = await this.request(
      "session/load",
      { sessionId, cwd, mcpServers: [] },
      120_000,
    );
    this.parseSessionExtras(res);
    this.sessionCwds.set(sessionId, cwd);
  }

  private parseSessionExtras(result: unknown): void {
    if (!result || typeof result !== "object") return;
    const r = result as {
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
      models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string; description?: string }> };
      configOptions?: Array<{
        id: string;
        currentValue?: string;
        options?: Array<{ value: string; name?: string; description?: string }>;
      }>;
    };
    if (r.modes?.availableModes?.length) this.availableModes = r.modes.availableModes;
    if (r.modes?.currentModeId) this.currentModeId = r.modes.currentModeId;
    if (r.models?.availableModels?.length) this.availableModels = r.models.availableModels;
    if (r.models?.currentModelId) this.currentModelId = r.models.currentModelId;

    // OpenCode ACP packs model/agent lists into configOptions.
    for (const opt of r.configOptions ?? []) {
      if (opt.id === "model" && opt.options?.length) {
        this.availableModels = opt.options.map((o) => ({
          modelId: o.value,
          name: o.name ?? o.value,
          description: o.description,
        }));
        if (opt.currentValue) this.currentModelId = opt.currentValue;
      }
      if ((opt.id === "agent" || opt.id === "mode") && opt.options?.length) {
        this.availableModes = opt.options.map((o) => ({
          id: o.value,
          name: o.name ?? o.value,
          description: o.description,
        }));
        if (opt.currentValue) this.currentModeId = opt.currentValue;
      }
    }

    // Derive connected providers from model ids (provider/model).
    const providers = new Set<string>();
    for (const m of this.availableModels) {
      const slash = m.modelId.indexOf("/");
      if (slash > 0) providers.add(m.modelId.slice(0, slash));
    }
    if (providers.size) this.connectedProviders = [...providers];
  }

  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      const id = this.nextId++;
      const start = Date.now();
      this.lastActivity.set(sessionId, start);
      this.running.add(sessionId);

      // Convert image blocks to ACP-friendly shape if needed.
      const prompt = content.map((cb) => {
        if (cb.type === "image" && cb.data) {
          return {
            type: "image",
            data: cb.data,
            mimeType: cb.mimeType ?? "image/png",
          };
        }
        return { type: "text" as const, text: cb.text ?? "" };
      });

      const watch = setInterval(() => {
        const last = Math.max(this.lastActivity.get(sessionId) ?? start, this.lastActivityAny);
        const idle = Date.now() - last;
        const total = Date.now() - start;
        if (total > this.promptMaxMs) {
          this.pending.delete(id);
          clearInterval(watch);
          this.running.delete(sessionId);
          void this.cancel(sessionId);
          reject(new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          this.pending.delete(id);
          clearInterval(watch);
          this.running.delete(sessionId);
          void this.cancel(sessionId);
          reject(new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);

      this.pending.set(id, {
        resolve: (v) => {
          this.running.delete(sessionId);
          resolve(v as PromptResult);
        },
        reject: (e) => {
          this.running.delete(sessionId);
          reject(e);
        },
        cleanup: () => clearInterval(watch),
        method: "session/prompt",
        sessionId,
      });

      try {
        this.transport!.send({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt },
        });
      } catch (e) {
        clearInterval(watch);
        this.pending.delete(id);
        this.running.delete(sessionId);
        reject(e as Error);
      }
    });
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      // ACP cancel is a notification (no id) on most agents.
      this.transport?.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    } catch (e) {
      log.debug("cancel failed:", (e as Error).message);
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const resolved = this.resolveModelId(modelId) ?? (modelId.includes("/") ? modelId : undefined);
    if (!resolved || resolved === "auto") {
      throw new OcError(`unknown model: ${modelId}`, -32602);
    }
    // Prefer session/set_config_option (OpenCode ACP); fall back to session/set_model.
    try {
      await this.request("session/set_config_option", { sessionId, configId: "model", value: resolved });
    } catch {
      await this.request("session/set_model", { sessionId, modelId: resolved });
    }
    this.currentModelId = resolved;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (this.availableModes.length > 0 && !this.availableModes.some((m) => m.id === modeId)) {
      throw new OcError(`unknown agent/mode: ${modeId}`, -32602);
    }
    // OpenCode ACP uses session/set_mode; config option id may be "mode" not "agent".
    try {
      await this.request("session/set_mode", { sessionId, modeId });
    } catch {
      try {
        await this.request("session/set_config_option", { sessionId, configId: "mode", value: modeId });
      } catch {
        await this.request("session/set_config_option", { sessionId, configId: "agent", value: modeId });
      }
    }
    this.currentModeId = modeId;
  }

  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    // Not all ACP agents expose this; best-effort.
    return this.request("session/command", { sessionId, command });
  }

  // ── Provider helpers (limited under ACP — models come from session config) ─

  async refreshDiscovery(): Promise<void> {
    // No separate discovery channel on ACP; models/modes are refreshed on
    // session/new and session/load. Opening a probe session is too expensive —
    // just no-op if we already have lists.
    if (this.availableModels.length === 0) {
      try {
        const sid = await this.newSession(this.opts.workspace);
        // Leave the probe session; loadSession of real work continues separately.
        log.info(`discovery session ${sid.slice(0, 12)} populated model/agent lists`);
      } catch (e) {
        log.warn(`refreshDiscovery failed: ${(e as Error).message}`);
      }
    }
  }

  getConnectedProviders(): string[] {
    return this.connectedProviders.slice();
  }

  isProviderConnected(id: string): boolean {
    return this.connectedProviders.includes(id);
  }

  async setProviderApiKey(providerId: string, _apiKey: string): Promise<boolean> {
    // Provider credentials are managed by `opencode auth login` under ACP.
    // Surface a clear failure so the Telegram handler can tell the user.
    log.warn(`setProviderApiKey(${providerId}): not available over ACP — use \`opencode auth login\``);
    return false;
  }

  async disconnectProvider(providerId: string): Promise<boolean> {
    log.warn(`disconnectProvider(${providerId}): not available over ACP — use \`opencode auth\``);
    return false;
  }

  /** Auth method list per provider — not exposed over ACP; empty map. */
  async getProviderAuth(): Promise<Record<string, Array<{ type: string; label: string }>>> {
    return {};
  }

  /** Not available over pure ACP; sessions are tracked via the bot's SessionStore. */
  async getMessages(_sessionId: string): Promise<Array<{ info: Record<string, unknown>; parts: unknown[] }>> {
    return [];
  }

  async listSessions(): Promise<Array<{ id: string; directory?: string; title?: string }>> {
    try {
      const res = (await this.request("session/list", {}, 30_000)) as {
        sessions?: Array<{ id?: string; sessionId?: string; directory?: string; cwd?: string; title?: string }>;
      };
      const list = res?.sessions ?? (Array.isArray(res) ? res : []);
      return (list as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.id ?? s.sessionId ?? ""),
        directory: (s.directory as string) ?? (s.cwd as string),
        title: s.title as string | undefined,
      })).filter((s) => s.id);
    } catch {
      return [];
    }
  }

  async getLiveSessions(): Promise<
    Map<
      string,
      {
        title: string;
        directory: string;
        status: "idle" | "busy" | "retry";
        updatedAt: number;
        createdAt: number;
      }
    >
  > {
    const map = new Map<
      string,
      {
        title: string;
        directory: string;
        status: "idle" | "busy" | "retry";
        updatedAt: number;
        createdAt: number;
      }
    >();
    for (const sid of this.running) {
      map.set(sid, {
        title: sid.slice(0, 8),
        directory: this.sessionCwds.get(sid) ?? "",
        status: "busy",
        updatedAt: Date.now(),
        createdAt: 0,
      });
    }
    return map;
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

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const ms = timeoutMs ?? this.timeout;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${ms}ms: ${method}`));
      }, ms);
      this.pending.set(id, { resolve, reject, cleanup: () => clearTimeout(timer), method });
      try {
        this.transport!.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id) && msg.method === undefined) {
      const p = this.pending.get(msg.id)!;
      p.cleanup();
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(this.toOcError(msg.error, p.method));
      } else {
        // session/prompt result may include usage → store as metadata.
        if (p.method === "session/prompt" && p.sessionId && msg.result && typeof msg.result === "object") {
          const usage = (msg.result as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } })
            .usage;
          if (usage?.totalTokens) {
            const prev = this.metadata.get(p.sessionId) ?? {};
            this.metadata.set(p.sessionId, { ...prev, totalTokens: usage.totalTokens });
          }
        }
        p.resolve(msg.result);
      }
      return;
    }
    // Request from the agent (has both id and method) — needs a response.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      void this.respondToServerRequest(msg.id, msg.method, (msg.params as Record<string, unknown>) || {});
      return;
    }
    // Notification (method, no id).
    if (msg.method) this.routeNotification(msg.method, msg.params);
  }

  private async respondToServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      let result: unknown;
      if (method === "session/request_permission") {
        const sessionId = String(params.sessionId ?? params.sessionID ?? "");
        this.touchActivity(sessionId || undefined);
        const opts = (params.options as Array<{ optionId: string; kind?: string; name?: string }>) ?? [];
        // When trust-all is on, never block the turn waiting for Telegram.
        if (this.opts.trustAllTools) {
          const always =
            opts.find((o) => /always/i.test(o.optionId) || o.kind === "allow_always") ??
            opts.find((o) => /allow/i.test(o.optionId) || o.kind === "allow") ??
            opts[0];
          result = always
            ? { outcome: { outcome: "selected", optionId: always.optionId } }
            : { outcome: { outcome: "cancelled" } };
        } else if (this.permissionHandler) {
          const normalized: RequestPermissionParams = {
            sessionId,
            toolCall: (params.toolCall as RequestPermissionParams["toolCall"]) ?? {
              toolCallId: params.toolCallId as string | undefined,
              title: (params.title as string) ?? (params.toolName as string),
              kind: params.kind as string | undefined,
              rawInput: (params.rawInput ?? params.input) as Record<string, unknown> | undefined,
            },
            options: opts.map((o) => ({
              optionId: o.optionId,
              name: o.name ?? o.optionId,
              kind: o.kind,
            })),
          };
          result = await this.permissionHandler(normalized);
        } else {
          result = { outcome: { outcome: "cancelled" } };
        }
      } else {
        throw new OcError(`unsupported client method: ${method}`, -32601);
      }
      this.transport?.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.transport?.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  private routeNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const p = params as SessionNotificationParams;
      if (p?.sessionId && p.update) {
        this.touchActivity(p.sessionId);
        this.emit("session-update", p.sessionId, p.update);
        return;
      }
    }
    this.emit("notification", method, params);
  }

  private touchActivity(sessionId?: string): void {
    const now = Date.now();
    this.lastActivityAny = now;
    if (sessionId) this.lastActivity.set(sessionId, now);
  }

  private toOcError(error: { code: number; message: string; data?: unknown }, method: string): OcError {
    const codeStr = typeof error.code === "number" ? ` [${error.code}]` : "";
    const text = `${error.message || "ACP error"}${codeStr}`;
    log.warn(`${method} failed: ${text}`);
    return new OcError(text, error.code, error.data);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
    this.running.clear();
  }
}

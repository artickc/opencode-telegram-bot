/**
 * Single-instance guard, keyed per bot token (NOT per folder), so the same bot
 * can't run twice no matter which directory it's started from.
 *
 * Telegram allows only ONE long-polling consumer per token — a second instance
 * triggers 409 Conflict and, worse, a leftover "ghost" process started from an
 * old folder keeps answering with a stale `.env` (e.g. an outdated
 * `ALLOWED_USERS`, so you get "⛔ Not authorized"). On startup we therefore
 * take an exclusive lock: if a still-alive instance holds it, we terminate that
 * process (and its child tree on Windows) so the fresh process — with the
 * current config — becomes the only consumer.
 *
 * The lock lives under the canonical home (`~/.opencode/tg/locks/<tokenHash>.lock`)
 * and stores only a pid + start time + whether the holder is supervised. The
 * token itself is never written to disk (only its hash names the file).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { killPid } from "../sessions/process.js";
import { isPidAlive } from "../sessions/store.js";
import { INSTANCE_DIR, PROJECT_ROOT } from "../config.js";

const log = createLogger("lock");

interface LockData {
  pid: number;
  startedAt: number;
  /** True when the holder runs under a supervisor (systemd/launchd/Task). */
  supervised: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class InstanceLock {
  private readonly file: string;
  private held = false;

  constructor(
    token: string,
    locksDir: string,
    private readonly supervised: boolean,
  ) {
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.file = join(locksDir, `${hash}.lock`);
  }

  /**
   * Become the sole instance for this token. Returns `false` (caller should
   * exit) only when a *supervised* service instance is already running and this
   * process is a plain manual start — we don't fight the background service
   * (that would cause a restart/kill loop). Otherwise we take over: a live
   * holder is terminated and the lock is rewritten with our pid.
   */
  async acquire(): Promise<boolean> {
    const existing = this.read();
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      if (existing.supervised && !this.supervised) {
        log.warn(`a supervised service instance is already running (pid ${existing.pid}); not starting a duplicate`);
        return false;
      }
      if (isOwnBotProcess(existing.pid)) {
        log.warn(`another opencode-telegram-bot instance is running (pid ${existing.pid}); terminating it to take over`);
        killPid(existing.pid);
        for (let i = 0; i < 20 && isPidAlive(existing.pid); i++) await sleep(150); // up to ~3s
        if (isPidAlive(existing.pid)) log.warn(`previous instance ${existing.pid} still alive after kill; continuing anyway`);
      } else {
        // The locked pid does NOT belong to this bot — either it was recycled to
        // an unrelated process (e.g. a sibling kiro-telegram-bot, which is also a
        // node/tsx process) or we can't confirm its identity. Never kill it; just
        // reclaim the stale lock. Killing here previously risked terminating a
        // different bot's live sessions.
        log.warn(`lock pid ${existing.pid} is not a confirmed opencode-telegram-bot process; reclaiming stale lock without killing it`);
      }
    }
    this.write();
    this.held = true;
    return true;
  }

  /** Release the lock if (and only if) we still own it. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const cur = this.read();
      if (cur?.pid === process.pid) rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private write(): void {
    const data: LockData = { pid: process.pid, startedAt: Date.now(), supervised: this.supervised };
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data), "utf-8");
    } catch (e) {
      log.warn(`could not write lock file ${this.file}: ${(e as Error).message}`);
    }
  }

  private read(): LockData | undefined {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<LockData>;
      if (typeof d.pid === "number" && d.pid > 0) {
        return { pid: d.pid, startedAt: Number(d.startedAt) || 0, supervised: Boolean(d.supervised) };
      }
    } catch {
      /* no/invalid lock */
    }
    return undefined;
  }
}

/**
 * Confirm that `pid` is a *this-bot* process (opencode-telegram-bot) before we
 * ever kill it, by matching its command line against our own entrypoint and
 * instance directory. This prevents terminating an unrelated node/tsx process
 * that happened to reuse the pid recorded in a stale lock — most importantly a
 * sibling `kiro-telegram-bot`, which is also launched via `node --import tsx`
 * and would otherwise satisfy a naive "is it node?" check. If we can't read the
 * command line, we return `false` (don't kill — safer for coexistence).
 */
function isOwnBotProcess(pid: number): boolean {
  const cmd = processCommandLine(pid);
  if (!cmd) return false;
  const hay = cmd.toLowerCase();
  const isNode = /node(\.exe)?\b|tsx/.test(hay);
  if (!isNode) return false;
  // Strong, bot-specific markers: the package/repo dir name, our entrypoint,
  // and this instance's config dir (passed as `--instance <dir>` by services).
  const markers = [
    "opencode-telegram-bot",
    "opencode-tg",
    PROJECT_ROOT.toLowerCase(),
    INSTANCE_DIR.toLowerCase(),
  ];
  return markers.some((m) => m && hay.includes(m));
}

/**
 * Best-effort full command line for a pid, or `undefined` if it can't be read.
 * Windows uses CIM (Win32_Process.CommandLine); Linux reads /proc; macOS uses
 * `ps -o command=`. All calls are time-boxed and never throw.
 */
function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      );
      const line = out.trim();
      return line || undefined;
    }
    if (process.platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      const line = raw.replace(/\0/g, " ").trim();
      return line || undefined;
    }
    // macOS / other unix
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const line = out.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

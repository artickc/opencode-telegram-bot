/**
 * Session store — discovers existing OpenCode sessions from disk.
 *
 * OpenCode stores sessions under `~/.local/share/opencode/sessions/`.
 * Each session has:
 *   <id>.json  — session metadata
 *   <id>.jsonl — message history (for /history and live tail)
 *
 * OpenCode doesn't use `.lock` files like Kiro did; active detection is
 * best-effort (the HTTP API's session.status is authoritative, but this
 * filesystem store is used for quick listing and offline history).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { SessionMeta } from "./types.js";

const log = createLogger("sessions:store");

/** OpenCode session JSON on disk. */
interface RawSessionJson {
  // OpenCode format
  id?: string;
  directory?: string;
  projectID?: string;
  title?: string;
  version?: string;
  time?: { created?: number; updated?: number; compacting?: number };
  // Legacy Kiro format (for backward compat)
  session_id?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  session_created_reason?: string;
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  /** Returns true once the sessions directory exists. */
  available(): boolean {
    try {
      return statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }

  /** List all sessions, most recently updated first. */
  list(limit = 50): SessionMeta[] {
    if (!this.available()) return [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      log.warn("cannot read sessions dir:", (e as Error).message);
      return [];
    }

    const metas: SessionMeta[] = [];
    for (const file of files) {
      const meta = this.readMeta(file);
      if (meta) metas.push(meta);
    }
    // Active sessions first, then most-recently-updated.
    metas.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt),
    );
    return metas.slice(0, limit);
  }

  /** List only sessions currently running on this PC (best-effort). */
  listActive(): SessionMeta[] {
    return this.list(200).filter((s) => s.active);
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.readMeta(`${sessionId}.json`);
  }

  jsonlPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  private readMeta(file: string): SessionMeta | undefined {
    const full = join(this.dir, file);
    let raw: RawSessionJson;
    let mtime = new Date(0).toISOString();
    try {
      raw = JSON.parse(readFileSync(full, "utf-8")) as RawSessionJson;
      mtime = statSync(full).mtime.toISOString();
    } catch {
      return undefined;
    }

    // Support both OpenCode (id/directory/time.*) and legacy Kiro formats.
    const sessionId = raw.id || raw.session_id || file.replace(/\.json$/, "");
    const cwd = raw.directory || raw.cwd || "";
    const title = (raw.title || "").trim() || "(untitled)";
    const createdAt = raw.time?.created
      ? new Date(raw.time.created).toISOString()
      : raw.created_at || mtime;
    const updatedAt = raw.time?.updated
      ? new Date(raw.time.updated).toISOString()
      : raw.updated_at || mtime;

    let historyBytes = 0;
    try {
      historyBytes = statSync(join(this.dir, `${sessionId}.jsonl`)).size;
    } catch {
      /* no history yet */
    }

    return {
      sessionId,
      cwd,
      title,
      createdAt,
      updatedAt,
      reason: raw.session_created_reason,
      lockPid: undefined,
      active: false,
      historyBytes,
    };
  }
}

/** Cross-platform "is this process still running?" check. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

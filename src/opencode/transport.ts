/**
 * Newline-delimited JSON-RPC framing over an ACP agent's stdio.
 * OpenCode (`opencode acp`) and the Agent Client Protocol use this wire format.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLogger } from "../logger.js";

const log = createLogger("oc:transport");

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcTransport extends EventEmitter {
  private buffer = "";

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    super();
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) log.debug("[opencode stderr]", msg.slice(0, 500));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        log.debug("non-JSON line ignored:", line.slice(0, 200));
        continue;
      }
      this.emit("message", parsed);
    }
  }

  send(msg: object): void {
    if (!this.proc.stdin.writable) {
      throw new Error("ACP process stdin is not writable");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}

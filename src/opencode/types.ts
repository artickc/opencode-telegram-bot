/**
 * Type definitions for the OpenCode client.
 *
 * These types mirror the types so the rest of the bot (session-runtime,
 * render, stream) can operate on a unified interface regardless of the
 * underlying agent backend.
 *
 * OpenCode uses an HTTP server + SSE events, but we translate those into the
 * same event-driven model the bot was built around.
 */

/** A content block in a prompt or message (compatible with ContentBlock). */
export interface ContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
  };
  agentInfo?: { name?: string; version?: string };
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptResult {
  stopReason?: string; // e.g. "end_turn", "cancelled", "max_tokens"
}

/** session/update notification payload (translated from OpenCode SSE events). */
export interface SessionUpdate {
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "user_message_chunk"
    | string;
  content?: ContentBlock;
  // tool_call / tool_call_update fields
  toolCallId?: string;
  title?: string;
  kind?: string; // "read" | "edit" | "execute" | "search" | ...
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  rawInput?: Record<string, unknown>;
  content_blocks?: ToolCallContent[];
  // Also nests content for tool calls as `content`
  [k: string]: unknown;
}

/** A piece of tool-call content (text, diff, etc.). */
export interface ToolCallContent {
  type: "content" | "diff" | string;
  path?: string;
  oldText?: string | null;
  newText?: string;
  content?: ContentBlock;
  [k: string]: unknown;
}

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

/** Permission request (translated from OpenCode permission.updated events). */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export type PermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

/**
 * Subagent info (OpenCode doesn't currently expose a subagent list in the same
 * way, but we keep the type for forward compatibility).
 */
export interface SubagentInfo {
  sessionId: string;
  sessionName?: string;
  agentName?: string;
  role?: string;
  initialQuery?: string;
  status?: { type?: string; message?: string };
  group?: string;
  dependsOn?: string[];
  hasLoop?: boolean;
  loopIteration?: number;
  loopMaxIterations?: number;
  createdAtMs?: number;
}

export interface PendingStage {
  name?: string;
  role?: string;
  agentName?: string;
  dependsOn?: string[];
  [k: string]: unknown;
}

export interface SubagentListUpdate {
  subagents?: SubagentInfo[];
  pendingStages?: PendingStage[];
}

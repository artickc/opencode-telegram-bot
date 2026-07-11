# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The latest section is published verbatim as the GitHub Release notes by
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

## [Unreleased]

## [2.0.0] - 2026-07-11

**First Stable Release.** OpenCode Telegram Bot is now stable — the first
production-ready release with all features complete and verified. Control
**OpenCode** from Telegram over the **Agent Client Protocol (ACP)** — `opencode
acp` over JSON-RPC/stdio. Switch projects, resume sessions, stream responses
with live diffs and rich tool-call detail, queue follow-ups, run scheduled
tasks, and run 24/7 as a cross-platform background service.

### Added

- **🔍 Rich tool-call detail for every kind.** Previously most tool calls showed
  only a bare icon + title line. Now each kind gets its own formatted card:
  - **Search** — query/pattern, search path, include/exclude filters,
    case-sensitivity flag.
  - **Read** — file path + line/offset/limit when present.
  - **Edit** — file path + unified diff block with `+added / -removed` count,
    smart-truncated for long changes (keeps first and last hunks, drops middle
    with a summary).
  - **Write / Create** — file path + content preview with automatic language
    detection for syntax highlighting (TypeScript, Python, Go, Rust, etc.).
  - **Delete** — the file being removed.
  - **Move / Rename** — source path → destination path.
  - **Execute** — the full command in a `bash` code block + working directory.
  - **Fetch / web_fetch** — URL, HTTP method, headers, and body preview.
  - **Web search** — query string + result count.
  - **MCP calls** — server + method + a compact argument preview.
  - **Generic / unknown** — description or message extracted from raw input.
- **✅ Tool status tracking.** `tool_call_update` notifications carrying
  `completed` or `failed` status are now shown (previously silently deduped).
  You now see the final ✅ or ❌ for each tool action, including diffs that arrive
  only in the completion update. Tool cards upsert in place (⏳ → ✅) instead of
  stacking duplicates.
- **🧩 JSONC support for MCP config.** OpenCode configs are often JSONC (comments
  + trailing commas). The MCP config reader now parses JSONC; toggles use a
  surgical text edit so comments and formatting are never wiped. Reads from
  `~/.config/opencode/opencode.json`, `.jsonc`, and `~/.opencode/opencode.json`.
- **🏷 Threaded replies + searchable hashtags.** Every message of a turn is sent
  as a reply to your prompt, and every bubble ends with `#proj_… #sess_…` tags.
- **🧹 Self-cleaning UI.** Transient menus, session/project cards, pickers and
  submenus auto-remove, keeping the chat tidy.
- **📥 File ingestion.** Send documents — text-like files are inlined into the
  prompt; binaries are saved and their path handed to the agent.
- **🎙 Voice messages.** Transcribe voice to prompts (configurable STT endpoint).
- **🔁 Auto-fork on context-full.** When a prompt fails transiently and the
  session's context is exhausted, the bot forks a linked continuation primed
  with the recent transcript and retries.
- **🔁 Transient-error auto-retry with backoff.** Retries with `6s → 12s → 24s
  → 48s → 60s` backoff before failing.
- **🔢 Message coalescing.** Rapid consecutive text messages (e.g. a long message
  Telegram split at 4096 chars) are coalesced into a single prompt.
- **📦 Release automation.** `.github/workflows/release.yml` builds a clean
  downloadable zip and publishes a GitHub Release on every `v*.*.*` tag, using
  the matching `CHANGELOG.md` section as the notes.
- **🤖 Agent instructions** — `AGENTS.md` documenting the architecture,
  conventions, and the batched-PR → conflict-resolve → merge → release workflow.
- **📋 Release checklist** — `docs/ops/RELEASE_CHECKLIST.md`.
- **🌍 StarMapper & Stars** — community sections in the README.

### Changed

- **Transport: HTTP/SSE → ACP over stdio.** The bot now runs `opencode acp` and
  speaks JSON-RPC on the agent process pipe (same model as the Grok bot). Mid-turn
  freezes from dropped SSE streams, wrong-directory event scopes, and silent
  TCP half-closes no longer apply — `session/update` chunks and the prompt
  completion travel on the same reliable stdio connection.
- **`formatToolCall` rewritten** from a single switch to per-kind formatter
  functions, each producing rich RAW markdown. Uses string concatenation instead
  of template literals to avoid backtick-in-fence escaping issues.
- **Diff rendering improved.** Long edits are now truncated *logically*: keep the
  first and last change hunks, drop middle hunks with a summary, and cap total
  lines so Telegram stays readable without losing the shape of the change.
- **Thinking tail shortened.** Long reasoning dumps no longer drown the chat;
  older thought lines are collapsed.
- **MCP config reads** now scan multiple candidate paths (`~/.config/opencode/`
  and `~/.opencode/`) and handle JSONC.

### Fixed

- **Second (and later) turns ended instantly with empty Done.** Persisted settings
  stored bare model aliases like `think` and agents like `Artur` that
  `hasModel`/`hasMode` treated as valid (suffix / constructor seed), then
  `setModel`/`setMode` failed or applied a phantom mode and ACP returned
  `end_turn` with no stream. Aliases are expanded to full `provider/model` ids;
  modes must be advertised by OpenCode before apply.
- **Tool cards stuck on ⏳ after Done.** ACP emits many updates per `toolCallId`;
  the streamer now upserts the same card through pending → completed.
- **First message showed only your prompt and no reply.** The client now tracks
  message roles, never streams user-role parts, and emits only the newly-appended
  suffix of each part's growing snapshot — no echo, no duplication.
- **Assistant reply could be lost or the prompt echoed on resumed sessions.**
  Out-of-order parts are now buffered and flushed once the role resolves, with a
  safety flush at `session.idle`.
- **Single-instance lock could terminate an unrelated process.** It now verifies
  the target's command line belongs to this bot before killing.

## [1.0.0] - 2026-07-08

### Changed — Full rewrite from Kiro CLI to OpenCode

This is a complete refactor of the bot to work with **OpenCode** instead of
Kiro CLI. All functionality is preserved; the underlying agent backend changed.

#### Architecture
- **Backend:** Kiro CLI ACP (JSON-RPC over stdio) → OpenCode HTTP/SSE server (`opencode serve` + `@opencode-ai/sdk`)
- **Session model:** ACP session/load → OpenCode session.create/promptAsync
- **Streaming:** ACP `session/update` notifications → SSE events (`message.part.updated`, `session.idle`)
- **Permissions:** ACP `session/request_permission` → OpenCode `permission.updated` SSE events
- **Configuration:** `KIRO_*` env vars → `OPENCODE_*` env vars

#### Removed (Kiro-specific)
- `/reauth` command and all Kiro auth flows
- `/accounts` command and multi-account support
- Auto-rotate-on-give-up
- `acp/` directory (replaced by `opencode/`)
- `app/auth-service.ts`, `app/kiro-credentials.ts`, `app/accounts.ts`
- `bot/account-rotator.ts`, `bot/reauth-controller.ts`
- `render/device-flow.ts`
- `agents/catalog.ts`

#### Added
- `opencode/client.ts` — `OpenCodeClient` class
- `opencode/types.ts` — Type definitions
- `@opencode-ai/sdk` dependency
- Cost tracking via OpenCode's `AssistantMessage.cost` field

#### Updated
- `config.ts` — All `KIRO_*` → `OPENCODE_*`
- All render/, sessions/, tasks/, service/, handlers/ files
- `package.json` — New name, added SDK dependency, updated bin names
- All documentation (README, INSTALL, UPGRADE, CONTRIBUTING, SECURITY)
- All install scripts
- Service labels (macOS LaunchAgent, systemd unit, Windows Scheduled Task)

[Unreleased]: https://github.com/artickc/opencode-telegram-bot/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/artickc/opencode-telegram-bot/releases/tag/v2.0.0
[1.0.0]: https://github.com/artickc/opencode-telegram-bot/releases/tag/v1.0.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-07-09

### Fixed

- **First message showed only your prompt and no reply.** OpenCode's HTTP/SSE
  model emits a `message.part.updated` for the *user's own* message, and the
  client streamed it back as agent output while also double-emitting assistant
  text (once via `message.part.delta`, once via the full `message.part.updated`
  snapshot). The client now tracks message roles (from `message.updated`),
  never streams user-role parts, and emits only the newly-appended suffix of
  each part's growing snapshot — no echo, no duplication.
- **Assistant reply could be lost or the prompt echoed on resumed sessions.**
  On resume, `message.part.updated` can arrive before its `message.updated`
  (role unknown). Such parts are now buffered and flushed once the role
  resolves (assistant → emit, user → discard), with a safety flush at
  `session.idle` so a reply is never dropped.
- **Single-instance lock could terminate an unrelated process.** The startup
  lock killed any stale-lock PID that merely looked like a node/tsx process —
  which could hit a sibling bot (also `node --import tsx`) if the OS had
  recycled the PID. It now verifies the target's command line belongs to this
  bot before killing, and never kills when it can't confirm.

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
- `/reauth` command and all Kiro auth flows (device flow, Builder ID, org login, import from IDE)
- `/accounts` command and multi-account support (Kiro SSO token model)
- Auto-rotate-on-give-up (no multi-account rotation for OpenCode)
- `acp/` directory (replaced by `opencode/`)
- `app/auth-service.ts`, `app/kiro-credentials.ts`, `app/accounts.ts`
- `bot/account-rotator.ts`, `bot/reauth-controller.ts`
- `render/device-flow.ts`
- `agents/catalog.ts`

#### Added
- `opencode/client.ts` — `OpenCodeClient` class that spawns `opencode serve`, subscribes to SSE events, and maps them to the bot's existing event interface
- `opencode/types.ts` — Type definitions mirroring the old ACP types for interface compatibility
- `@opencode-ai/sdk` dependency
- Cost tracking via OpenCode's `AssistantMessage.cost` field

#### Updated
- `config.ts` — All `KIRO_*` → `OPENCODE_*`, paths `~/.kiro` → `~/.opencode`
- `index.ts` — Uses `OpenCodeClient`
- `bot/session-runtime.ts` — Uses OpenCodeClient API, removed account rotator
- `bot/bot.ts` — Removed auth/account handler registration
- `bot/registry.ts` — Uses OpenCodeClient, removed account rotator
- `bot/chat-controller.ts` — Uses OpenCodeClient, removed rotator parameter
- All render/, sessions/, tasks/, service/, handlers/ files — Updated imports
- `app/usage.ts` — Uses OpenCodeClient for provider/model info
- `package.json` — New name, added SDK dependency, updated bin names
- All documentation (README, INSTALL, UPGRADE, CONTRIBUTING, SECURITY)
- All install scripts (install.cmd, install.sh, start.cmd, setup.mjs)
- Service labels (macOS LaunchAgent, systemd unit, Windows Scheduled Task)

[1.0.0]: https://github.com/artickc/opencode-telegram-bot/releases/tag/v1.0.0

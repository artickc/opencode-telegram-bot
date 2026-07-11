# Reddit Post — OpenCode Telegram Bot

> Copy the content below into a Reddit post (markdown mode).
> Suggested subreddits: r/opencode, r/programming, r/SideProject, r/selfhosted,
> r/Telegram, r/opensource, r/node, r/artificial, r/LocalLLaMA

---

## Title

I built a Telegram bot that controls OpenCode from your phone — stream code, diffs, tool calls, and run it 24/7 as a background service

## Body

I've been using OpenCode as my primary AI coding agent, but I kept wishing I could check in on it from my phone — start a task before I leave my desk, see the diff when it's done, queue a follow-up from the couch, and let it run overnight on a schedule.

So I built **OpenCode Telegram Bot** — a bridge that drives OpenCode over the Agent Client Protocol (ACP) from a Telegram chat. It's open source, runs 24/7 as a cross-platform daemon, and just hit v2.0.0 (first stable release).

### What it does

- **Projects & sessions** — `/projects` to pick a folder, `/sessions` to resume. Multiple sessions at once with `/running` to switch between them.
- **Live streaming** — watch the agent type in real time, with live typing indicators and clean MarkdownV2 rendering.
- **Rich tool-call cards** — every tool gets its own formatted card: file reads (path + line numbers), edits (unified diff with +N -M stats), shell commands (bash blocks), searches (pattern + scope + filters), writes (content preview with syntax highlighting), deletes, moves, fetches, MCP calls — each with ⏳ → ✅/❌ status.
- **Edit diffs** — smart-truncated unified diffs so you see exactly what changed without flooding the chat.
- **Progress bar** — the agent appends a `{progress: N%}` marker; the bot hides it and renders a green loading bar. Falls back to a bot-computed bar when the agent doesn't emit markers.
- **Scheduled tasks** — cron-like prompts that run on a schedule and deliver results to your chat. Great for overnight builds, periodic checks, etc.
- **MCP control** — `/mcp` lists your MCP servers, health-checks them (which connected / failed and why), and toggles them on/off.
- **Subagent visibility** — when OpenCode delegates to subagents, you see each one start, work, and finish.
- **Voice, images, files** — send a voice note (transcribed to a prompt), photos (attached as image content blocks), or documents (text files inlined, binaries path-passed).
- **Self-healing** — auto-fork on context-full, transient-error retry with backoff, auto-restart, single-instance guard.
- **Inline approvals** — approve/deny risky tool calls from Telegram buttons.
- **24/7 daemon** — installs as a user service on Windows (Startup folder / Task Scheduler), Linux (systemd), macOS (launchd). Auto-updates when idle.
- **Threaded replies** — every message is a reply to your prompt, with searchable `#proj_… #sess_…` hashtags.
- **Self-cleaning UI** — transient menus auto-remove so the chat stays tidy.

### How it works

```
Telegram → Bot (grammY) → opencode acp (JSON-RPC over stdio)
                              ├─ session/new · session/load
                              ├─ session/prompt
                              └─ session/update (streamed text, tools)
```

One `opencode acp` process multiplexes many sessions. The bot speaks JSON-RPC 2.0 over the agent's stdio pipe — no HTTP server, no SSE, no ports to open.

### Install

```bash
npm install -g @artickc/opencode-telegram-bot
opencode-tg setup    # configure .env + detect opencode
opencode-tg install  # install as 24/7 background service
```

Or clone and run:

```bash
git clone https://github.com/artickc/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install && npm run setup
npm start
```

### Tech

- **Node.js ≥ 20**, TypeScript via `tsx` (no build step)
- **grammY** for Telegram, **diff** for unified diffs
- **ACP over stdio** (JSON-RPC 2.0) — not HTTP/SSE
- ~10k lines of TypeScript, MIT licensed

### Links

- **GitHub:** [artickc/opencode-telegram-bot](https://github.com/artickc/opencode-telegram-bot)
- **npm:** [@artickc/opencode-telegram-bot](https://www.npmjs.com/package/@artickc/opencode-telegram-bot)
- **Install guide:** [docs/INSTALL.md](https://github.com/artickc/opencode-telegram-bot/blob/main/docs/INSTALL.md)

### Other bots in the family

I've built similar Telegram bridges for other AI coding agents — same architecture, different backends:

| Bot | Agent | Transport |
|---|---|---|
| **[OpenCode Telegram Bot](https://github.com/artickc/opencode-telegram-bot)** | OpenCode | ACP over stdio |
| **[Grok Telegram Bot](https://github.com/artickc/grok-telegram-bot)** | Grok Build CLI | ACP over stdio |
| **[Codex Telegram Bot](https://github.com/artickc/codex-telegram-bot)** | OpenAI Codex | ACP over stdio |
| **[Kiro Telegram Bot](https://github.com/artickc/kiro-telegram-bot)** | Kiro CLI | ACP over stdio |

All four share the same multi-session runtime, renderer, scheduler, and daemon — pick the agent you use, or run several side by side (each with its own BotFather token).

### What's next

- Per-session token & cost meter
- Text-to-speech replies
- Scheduled-task chaining (run B after A)
- Team mode (per-user sessions, roles, audit log)
- Docker image
- Webhook mode for serverless

Feedback and feature requests welcome — open an issue on GitHub!

---

*If this is useful, a ⭐ on [GitHub](https://github.com/artickc/opencode-telegram-bot) really helps!*

# OpenCode Telegram Bot 🤖

> **Control [OpenCode](https://opencode.ai/) from Telegram.** Your AI coding
> assistant in your pocket — switch projects, resume and attach to live coding
> sessions, stream answers with diffs, queue follow-ups, and run it 24/7 as a
> background service on Windows, Linux, and macOS.

![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Protocol](https://img.shields.io/badge/protocol-HTTP%2FSSE-orange)

A professional Telegram bridge for the **OpenCode HTTP/SSE API** that
turns OpenCode into a mobile, always-on AI pair programmer. Send a message from
anywhere and watch OpenCode read files, run commands, and edit code on your machine
— with live typing indicators, clean Telegram markdown, and unified edit diffs.

---

## ✨ Features

| Capability | What it does |
|---|---|
| 🗂 **Projects** | `/projects` browses your folders and runs OpenCode in the one you pick. |
| ♻️ **Resume sessions** | `/sessions` lists recent OpenCode sessions; tap to resume. |
| 🟢 **Connect to live sessions** | `/active` shows sessions running **right now** on your PC. Watch them live, or continue them. |
| 🛑 **Kill a session / PID** | Each live `/sessions` · `/active` card has a **🛑 Kill · pid N** button (confirm-guarded) that stops that session's process and its child tree; `/killall` stops them all. |
| 📡 **Live watch** | Follow a running session read-only in real time. |
| 🧭 **Always-visible menu** | A persistent keyboard plus a pinned status panel showing your current **project, agent, model, session and queue**. |
| ⏰ **Scheduled tasks** | Create prompts that run on a schedule (once / daily / weekly / monthly / every-N-minutes) in a chosen project. |
| 🖼 **Multi-image prompts** | Send one or many photos (albums included) with a caption — all attached to the prompt. |
| 📜 **History** | `/history` shows the latest messages of any session. |
| 🧩 **MCP control** | `/mcp` lists MCP servers, **health-checks** them, and **enables/disables** them. |
| 📈 **Task progress bar** | A green 0–100% loading bar on the live message (`SHOW_PROGRESS`). |
| 🪙 **Cost & usage** | The `✅ Done` line and `/usage` show cost used, turns this session, and provider info. |
| ⌨️ **Typing indicator** | Stays on for the whole turn, even through long tool chains. |
| 📥 **Queued follow-ups** | Message while OpenCode is busy — it's queued and runs next. `/btw` runs it ASAP; `/flush` runs the queue now. |
| ✏️ **Edit diffs** | File edits show as unified `diff` blocks with `+N -M` stats. |
| 💬 **Quality markdown** | Converts agent markdown to Telegram **MarkdownV2** with safe escaping. |
| 🔁 **Self-healing** | Auto-restarts the OpenCode server with backoff and re-binds your session. |
| 🖥 **Runs 24/7** | 1-click install as a background service that starts on boot — Windows, Linux, macOS. |
| 🔒 **Access control** | Restrict to specific Telegram user IDs. |

---

## ⚡ Install from npm

```bash
npm install -g opencode-telegram-bot
```

By default your config lives in a **canonical, path-independent home** —
`~/.opencode/tg/` (its `.env`, `logs/`, `data/`) — so the bot loads the **same**
`.env` no matter which folder you start it from.

```bash
opencode-tg setup            # auto-detects opencode, writes ~/.opencode/tg/.env
opencode-tg setup --path     # print the .env location
# edit that .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
opencode-tg run              # foreground …
opencode-tg install          # … or install as a 24/7 background service
```

The bot is **single-instance per token**: starting it again terminates any
ghost/duplicate that was still polling Telegram.

Startup options: `opencode-tg setup [--path] | run | install | status | logs [n] |
stop | restart | uninstall`.

See **[docs/INSTALL.md](./docs/INSTALL.md)** for the full guide.

---

## 🚀 1-click install

Clone or download, then run the installer for your OS.

**Windows** — double-click `install.cmd`

**Linux / macOS**:
```bash
chmod +x install.sh && ./install.sh
```

### Prerequisites

- **OpenCode** installed and configured — run `opencode --version` to confirm.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

---

## 🧑‍💻 Manual setup

```bash
npm install
npm run setup            # auto-detects opencode + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start
```

No build step — TypeScript runs directly via `tsx`.

---

## 🛠 Run as a background service (daemon)

| OS | Mechanism | Starts on |
|---|---|---|
| Windows | Hidden Scheduled Task (elevated) · per-user **Startup folder** (no admin) | logon |
| Linux | systemd **user** service (+ linger) | boot |
| macOS | launchd LaunchAgent | login |

```bash
npm run install:service     # install + start, enable autostart
npm run service -- status   # show install + running state
npm run service -- stop
npm run service -- restart
npm run service -- logs 200 # tail the log file
npm run uninstall:service   # stop + remove
```

Or use the `opencode-tg` command: `opencode-tg install | status | logs`.

Logs are written to `logs/opencode-telegram-bot.log` (rotated at 5 MB).

---

## 💬 Commands

```
/menu         Show the persistent menu keyboard
/projects     List · /projects <q> search · /projects <path> open any folder · /projects new <name>
/sessions     List & resume sessions (active first) · /sessions <q> to filter
/active       Sessions running now on the PC
/running      Sessions this chat controls — switch between them
/killall      Kill all active sessions on the PC (with confirm)
/mcp          Inspect MCP servers · health-check · enable/disable
/tasks        Manage scheduled tasks
/newtask      Create a scheduled task (wizard)
/history      Show recent conversation history
/new          Start a fresh session here
/status       Current session, project & queue
/usage        Provider info & current context usage
/btw <text>   Run it now if idle, else queue to run right after the current task
/flush        Send queued follow-ups now
/queue        Show queued follow-ups
/cancel       Stop the current turn
/unwatch      Stop following a live session
/model <id>   Switch the model for this session
/restart      Restart the OpenCode agent
/help         Show help
```

Anything that isn't a command is sent to OpenCode as a prompt. While a turn is
running, your messages are queued and sent automatically when it finishes.

---

## 🧭 The menu & status panel

A tiny **persistent bar** sits under the message box — **☰ Menu · 🧭 Running ·
⏹ Stop**. Tap **☰ Menu** (or `/menu`) to open a grouped **inline menu**: Project ·
New · Running · Sessions · Agent · Model · Reasoning · Tasks · Status · Usage ·
Stop · Kill all.

While a task is running, a **pinned status panel** appears showing your current
**task progress, activity, queue, project, session, context %, agent, model**,
updating live — and it's **removed when the session goes idle**.

## ⏰ Scheduled tasks

A task is a **prompt + a project + a schedule**. When it fires, the bot opens a
session in that project, runs the prompt, and delivers the result to your chat.

- **/newtask** launches a guided wizard: name → prompt → project → schedule → confirm.
- **Schedules**: `once` at a date/time, `daily` at HH:MM, `weekly`, `monthly`, or `interval` (every N minutes).
- **/tasks** lists everything with buttons to **run now, enable/disable, edit** and **delete**.

Tasks survive restarts; the scheduler runs them whether you're online or not.

## 🖼 Sending images

Send one or several photos — including a Telegram **album** — with an optional
caption. The bot downloads them and attaches them all to the prompt as image
content blocks.

**Images come back too:** when the agent produces images during a turn, the bot
detects the freshly-written files and sends them back to Telegram automatically
(`SEND_AGENT_IMAGES`).

## 🎙 Sending voice

Send a voice note and the bot transcribes it and runs it as a prompt. Configure
any OpenAI/Whisper-compatible endpoint via `STT_API_URL` in `.env`.

## 📎 Sending files

Send any **document** and the bot resolves it. **Text-like files** are downloaded,
decoded, and inlined into the prompt. **Binary files** are saved under
`<data>/downloads` and their path is handed to the agent.

---

## ⚙️ Configuration (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | — | Bot token from @BotFather. |
| `ALLOWED_USERS` | recommended | *(all)* | Comma-separated Telegram user IDs. |
| `OPENCODE_PATH` | no | auto / `opencode` | Path to the `opencode` binary. |
| `OPENCODE_WORKSPACE` | no | cwd | Default working directory. |
| `OPENCODE_AGENT` | no | — | Custom agent from `.opencode/agents/`. |
| `OPENCODE_TRUST_ALL_TOOLS` | no | `true` | Run tools without prompts. |
| `PROJECT_ROOTS` | no | workspace parent + home | Roots for `/projects`. |
| `STREAM_THROTTLE_MS` | no | `1500` | Live-edit interval while streaming. |
| `SHOW_TOOL_CALLS` | no | `true` | Show tool-call status messages. |
| `SHOW_EDIT_DIFFS` | no | `true` | Show unified diffs for edits. |
| `DIFF_MAX_LINES` | no | `120` | Max diff lines shown inline. |
| `SHOW_PROGRESS` | no | `true` | Green 0–100% progress bar. |
| `PROGRESS_FALLBACK` | no | `true` | Computed progress bar fallback. |
| `OPENCODE_AUTO_RESTART` | no | `true` | Auto-restart the server if it exits. |
| `OPENCODE_TG_SINGLE_INSTANCE` | no | `true` | Enforce one running bot per token. |
| `AUTO_UPDATE` | no | `true` | Auto-update when idle. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

See `.env.example` for the full list with comments.

---

## 🧩 How it works

```
Telegram  ──HTTPS──▶  Bot (grammY)
                          │  spawns once
                          ▼
                  opencode serve  ◀── HTTP/SSE (SDK) ──▶  Bot
                          │
                          ├─ session.create         (projects, resume)
                          ├─ session.promptAsync    (your messages)
                          └─ SSE events             (streamed text, tools)
```

One `opencode serve` process manages many sessions. Streamed SSE events
(`message.part.updated`, `session.idle`) are assembled into live, throttled
messages; tool events render as professional status lines with diffs.

---

## 📁 Project layout

```
src/
├── index.ts              Entry point, daemon-friendly logging, shutdown
├── cli.ts                CLI: run / install / start / stop / status / logs
├── config.ts             .env loading, paths, daemon options
├── logger.ts             Leveled logger with file output
├── opencode/             OpenCode HTTP/SSE client, types (via @opencode-ai/sdk)
├── sessions/             Session discovery, history parser, live tail watcher
├── projects/             Project directory discovery
├── mcp/                  MCP config (list/toggle) + live health probe
├── render/               Markdown→MarkdownV2, diffs, tool formatting, chunking
├── stream/               Incremental edit-streaming
├── service/              Cross-platform daemon (windows/linux/macos + selector)
└── bot/                  grammY bot, per-chat runtime, handlers
```

---

## ❓ FAQ

**Can I run the bot 24/7 on a server?** Yes — `npm run install:service`
installs a user-level service that starts on boot and auto-restarts on crash.

**How do I control OpenCode from my phone?** Set up the bot, message it on
Telegram, and pick a project with `/projects`. Every message becomes a prompt.

**Can multiple people use one bot?** Add their IDs to `ALLOWED_USERS`. Each chat
gets its own session.

**Does it support custom agents and MCP servers?** Yes — set `OPENCODE_AGENT`,
and the bot works with MCP servers configured in OpenCode's config.

---

## 🔐 Inline approvals

When OpenCode asks the client to approve a risky tool call (`permission.updated`
events), it appears in Telegram with **Approve / Deny** buttons. Set
`OPENCODE_TRUST_ALL_TOOLS=false` to enable this mode.

## 🔐 Security

This bot lets authorized Telegram users run commands and edit files on the host.
**Always set `ALLOWED_USERS`**, keep `.env` private, and run as a non-privileged
user. See [SECURITY.md](./SECURITY.md) for the full model.

---

## 🤝 Contributing

Contributions are very welcome! See **[CONTRIBUTING.md](./CONTRIBUTING.md)** to get
started — no build step is required (`npm run dev`), and `npm run typecheck` must
pass.

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 📦 Download & Releases

Grab the latest packaged build from the
[**Releases**](https://github.com/artickc/opencode-telegram-bot/releases) page.

---

## 📄 License

[MIT](./LICENSE) — see also [CONTRIBUTING](./CONTRIBUTING.md) and
[Code of Conduct](./CODE_OF_CONDUCT.md).

---

<sub>Keywords: OpenCode Telegram bot, AI coding assistant on Telegram, mobile AI
pair programming, remote coding agent, run AI agent as a service,
Windows/Linux/macOS daemon, ChatOps for developers.</sub>

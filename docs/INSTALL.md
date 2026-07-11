# 📦 Install guide

Get the OpenCode Telegram Bot running in a few minutes.

- **[Option A — npm (recommended)](#option-a--npm-recommended)**
- **[Option B — 1-click installer](#option-b--1-click-installer)**
- **[Option C — manual / from source](#option-c--manual--from-source)**

## Prerequisites

- **OpenCode** installed and configured — run `opencode --version` to confirm.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

---

## Option A — npm (recommended)

```bash
npm install -g @artickc/opencode-telegram-bot
```

This gives you the **`opencode-tg`** command. It ships with the `tsx` runtime,
so there's no build step.

```bash
opencode-tg setup                   # auto-detects opencode, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
opencode-tg run                     # run in the foreground
```

### Startup options (`opencode-tg <command>`)

| Command | What it does |
|---|---|
| `opencode-tg setup [token] [userId]` | Create/update `.env` (auto-detects `opencode` + project roots). |
| `opencode-tg run` | Run the bot in the foreground. |
| `opencode-tg install` | Install + start a **24/7 background service**. |
| `opencode-tg status` | Show install + running state. |
| `opencode-tg logs [n]` | Tail the last `n` log lines. |
| `opencode-tg stop` / `restart` / `start` | Control the running service. |
| `opencode-tg uninstall` | Stop + remove the service. |
| `opencode-tg help` | Show all commands. |

Update later with `npm install -g @artickc/opencode-telegram-bot@latest`.

---

## Option B — 1-click installer

Every [release](https://github.com/artickc/opencode-telegram-bot/releases) ships a
clean zip (no `node_modules`, `.env`, logs or data).

1. **Download** and unzip the latest release.
2. **Run the installer:**

   **Windows** — double-click `install.cmd`

   **Linux / macOS**:
   ```bash
   chmod +x install.sh && ./install.sh
   ```

3. **Set access control.** Open `.env` and set `ALLOWED_USERS`.

---

## Option C — manual / from source

```bash
git clone https://github.com/artickc/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install
npm run setup            # auto-detects opencode + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start                # or: npm run dev  (auto-reload)
```

---

## Configuration

All options live in `.env`. See the **Configuration** table in the
[README](../README.md) for every variable and its default.

## Troubleshooting

- **Bot doesn't respond** — confirm your ID is in `ALLOWED_USERS` and the token
  is correct; check `logs/opencode-telegram-bot.log` (run `opencode-tg logs`).
- **`opencode` not found** — set `OPENCODE_PATH` in `.env` to the binary's full
  path.
- **Transient errors** — the bot auto-retries with backoff; switch model with
  `/model <id>` if a model stays busy.

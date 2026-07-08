# ⬆️ Upgrade guide

How to update OpenCode Telegram Bot to the newest version.

> **Your config is safe.** Upgrading only replaces the bot's *code*. Your
> settings — `.env`, `data/` and `logs/` — live **outside** the code and are
> never overwritten by an upgrade.

## Which install do I have?

```bash
opencode-tg --version 2>/dev/null || npm ls -g opencode-telegram-bot
```

## A — Upgrade an npm install

### Automatic (default)

Global npm installs **update themselves**. With `AUTO_UPDATE=true` (the default),
the bot checks npm hourly and, **when it's fully idle**, runs
`npm install -g opencode-telegram-bot@latest`, restarts, and posts the changelog.

### Manual

```bash
npm install -g opencode-telegram-bot@latest
opencode-tg restart
```

## B — Upgrade a 1-click / zip install

1. **Stop the service:** `npm run service -- stop`
2. **Download** the latest release zip and unzip into a fresh folder.
3. **Carry your config** — copy `.env` and `data/` from the OLD folder.
4. **Install:** `npm install && npm run install:service`

## C — Upgrade a git / source install

```bash
cd opencode-telegram-bot
git pull
npm install
```

Then restart the bot.

## Pin a version / roll back

```bash
npm install -g opencode-telegram-bot@1.0.0
```

Set `AUTO_UPDATE=false` to stay on a pinned version.

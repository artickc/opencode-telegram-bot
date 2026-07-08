/**
 * OpenCode Telegram Bot — entry point.
 * Spawns the OpenCode server, starts the Telegram bot, and wires graceful
 * shutdown between them.
 */
import { OpenCodeClient } from "./opencode/client.js";
import { createBot } from "./bot/bot.js";
import { CANONICAL_DIR, loadConfig } from "./config.js";
import { InstanceLock } from "./app/instance-lock.js";
import { join } from "node:path";
import { createLogger, enableFileLogging, setLogLevel } from "./logger.js";

async function main(): Promise<void> {
  // Immediate feedback before any async work, so `npm start` shows life at once.
  process.stdout.write("\u{1F916} OpenCode Telegram Bot \u2014 starting\u2026\n");

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  enableFileLogging(cfg.logFile);
  const log = createLogger("main");

  // Single-instance guard: kill any ghost/duplicate already polling this token
  // (the usual cause of a stale "Not authorized" — an old process with an
  // outdated .env). A plain manual start yields to a running background service.
  const lock = new InstanceLock(cfg.token, join(CANONICAL_DIR, "locks"), process.env.OPENCODE_TG_SUPERVISED === "1");
  if (cfg.singleInstance && !(await lock.acquire())) {
    process.stdout.write(
      "\u26D4 Another OpenCode Telegram Bot is already running for this token (a background service). Use `opencode-tg restart`, or `opencode-tg stop` first.\n",
    );
    process.exit(0);
  }

  log.info("starting OpenCode Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`opencode:  ${cfg.opencodePath}`);
  log.info(`log file:  ${cfg.logFile}`);

  const client = new OpenCodeClient({
    opencodePath: cfg.opencodePath,
    workspace: cfg.workspace,
    trustAllTools: cfg.trustAllTools,
    agent: cfg.agent,
    autoRestart: cfg.acpAutoRestart,
    promptIdleTimeoutMs: cfg.promptIdleMs,
  });

  await client.start();
  const { bot, registry, scheduler, updater } = await createBot(cfg, client);
  scheduler.start();
  await updater.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down\u2026");
    scheduler.stop();
    updater.stop();
    registry.disposeAll();
    void bot.stop().catch(() => {});
    client.stop();
    lock.release();
    setTimeout(() => process.exit(code), 500);
  };

  client.on("exit", () => {
    if (!cfg.acpAutoRestart) {
      log.error("opencode serve exited and auto-restart is off \u2014 stopping bot.");
      shutdown(1);
    }
  });
  client.on("restarted", () => log.info("OpenCode server restarted; sessions will re-bind on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException:", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection:", err));

  await bot.start({
    onStart: (info) => {
      log.info(`bot online as @${info.username}`);
      process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Easy setup: creates/updates the bot's .env, auto-detects the opencode binary
 * and sensible PROJECT_ROOTS, and optionally writes the bot token / user id:
 *
 *   node scripts/setup.mjs [--path] [--instance <dir>] [<TELEGRAM_BOT_TOKEN> [ALLOWED_USER_ID]]
 *
 * By default the .env lives in the canonical, path-independent home
 * `~/.opencode/tg/.env`, so the bot loads the SAME config no matter where it's
 * started from. A `.env` already present in the current folder (an explicit
 * per-folder checkout) is used instead. `--path` just prints the resolved .env
 * path and exits (nothing is written).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(root, ".env.example");
const CANONICAL_DIR = join(homedir(), ".opencode", "tg");

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Mirror of config.ts resolveInstanceDir() so setup writes EXACTLY where the
 *  bot will read from. Keep the two in sync. */
function resolveInstanceDir() {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  const envDir = (process.env.OPENCODE_TG_DIR || process.env.OPENCODE_TG_CWD || "").trim();
  if (envDir) return resolve(expandHome(envDir));
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

// Parse args: flags (--path, --instance <dir>) vs positional token/user.
const argv = process.argv.slice(2);
let pathOnly = false;
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--path") pathOnly = true;
  else if (a === "--instance") i++; // value consumed by resolveInstanceDir()
  else positionals.push(a);
}
const [tokenArg, userArg] = positionals;

const instanceDir = resolveInstanceDir();
const envPath = join(instanceDir, ".env");

if (pathOnly) {
  console.log(envPath);
  process.exit(0);
}

mkdirSync(instanceDir, { recursive: true });

function detectOpencode() {
  const candidates = [
    join(homedir(), "AppData", "Roaming", "npm", "opencode.cmd"),
    join(homedir(), "AppData", "Roaming", "npm", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

function detectRoots() {
  const guesses = ["H:\\Lucru\\Domains", "C:\\Lucru\\Domains", join(homedir(), "projects")];
  return guesses.filter((p) => existsSync(p));
}

let env = existsSync(envPath)
  ? readFileSync(envPath, "utf-8")
  : readFileSync(examplePath, "utf-8");

function setVar(key, value) {
  if (value === undefined || value === "") return;
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

const oc = detectOpencode();
if (oc) {
  setVar("OPENCODE_PATH", oc);
  console.log(`\u2713 Found opencode: ${oc}`);
} else {
  console.log("! opencode not auto-detected \u2014 set OPENCODE_PATH in .env or ensure it's on PATH.");
}

const roots = detectRoots();
if (roots.length) {
  setVar("PROJECT_ROOTS", roots.join(","));
  console.log(`\u2713 PROJECT_ROOTS: ${roots.join(", ")}`);
}

if (tokenArg) {
  setVar("TELEGRAM_BOT_TOKEN", tokenArg);
  console.log("\u2713 Wrote TELEGRAM_BOT_TOKEN");
}
if (userArg) {
  setVar("ALLOWED_USERS", userArg);
  console.log(`\u2713 Wrote ALLOWED_USERS=${userArg}`);
}

writeFileSync(envPath, env, "utf-8");
console.log(`\n\u2713 .env written to ${envPath}`);
console.log("  (loaded from here no matter which folder you start the bot in)");

if (!/^TELEGRAM_BOT_TOKEN=.+/m.test(env)) {
  console.log("\nNext: open .env and paste your bot token from @BotFather, then run `opencode-tg run` (or `npm start`).");
} else {
  console.log("\nReady! Run `opencode-tg run` (or `npm start`).");
}

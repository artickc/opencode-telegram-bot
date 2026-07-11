/**
 * Instruction appended to every prompt so the agent never blocks a turn on a
 * long-lived process (dev servers, watchers, tunnels, daemons).
 *
 * IMPORTANT for maintainers:
 *  - Keep this string "tidy-idempotent": no trailing spaces on any line, no run
 *    of 3+ newlines, and no trailing whitespace at the end — `cleanStoredText`
 *    strips it by exact match after `extractProgress`/`tidy`.
 *  - Do not put `{progress: …}` tokens here; progress has its own directive.
 */

/** Platform-aware rule block: Unix uses nohup; Windows uses Start-Process / start /b. */
export function shellDirective(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return [
      "SHELL / LONG-RUNNING COMMANDS \u2014 MANDATORY (Windows):",
      "Never run a command that can block forever in the foreground (dev servers, watchers, tunnels, daemons, interactive REPLs, `npm run dev`, `opencode serve`, `sleep infinity`, read-from-stdin, etc.). Blocking the shell freezes the whole agent turn and the Telegram bot looks stuck.",
      "Always detach long-lived processes so the tool returns immediately:",
      "  \u2022 Preferred: Start-Process -NoNewWindow -FilePath <exe> -ArgumentList <args> -RedirectStandardOutput <log> -RedirectStandardError <log> -PassThru",
      "  \u2022 Or: cmd /c start /b <command> > <log> 2>&1",
      "  \u2022 Or: powershell -Command \"Start-Process ...\"",
      "Then verify with a short non-blocking check (e.g. Test-NetConnection, Get-Process, curl once) and keep working. Do not wait/poll in a loop that never exits.",
      "Prefer non-interactive flags (`-y`, `--yes`, `CI=1`) so tools never hang on prompts. One-shot commands (builds, tests, git, file ops) may run in the foreground with a reasonable timeout. Only long-lived / infinite processes must be backgrounded.",
    ].join("\n");
  }
  return [
    "SHELL / LONG-RUNNING COMMANDS \u2014 MANDATORY (Unix):",
    "Never run a command that can block forever in the foreground (dev servers, watchers, tunnels, daemons, interactive REPLs, `npm run dev`, `opencode serve`, `sleep infinity`, read-from-stdin, etc.). Blocking the shell freezes the whole agent turn and the Telegram bot looks stuck.",
    "Always detach long-lived processes with nohup so the tool returns immediately:",
    "  nohup <command> > <logfile> 2>&1 &",
    "Then verify with a short non-blocking check (e.g. curl once, pgrep, ss) and keep working. Do not wait/poll in a loop that never exits.",
    "Prefer non-interactive flags (`-y`, `--yes`, `CI=1`) so tools never hang on prompts. One-shot commands (builds, tests, git, file ops) may run in the foreground with a reasonable timeout. Only long-lived / infinite processes must be backgrounded with nohup.",
  ].join("\n");
}

/** Default directive for the current host (used at prompt build time). */
export const SHELL_DIRECTIVE = shellDirective();

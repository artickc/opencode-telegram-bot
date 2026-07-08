/**
 * /usage — show provider info and the current session's context usage.
 */
import type { Bot, Context } from "grammy";
import type { BotDeps } from "../deps.js";

export async function showUsage(ctx: Context, deps: BotDeps): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const rt = deps.registry.get(ctx.chat!.id);
  const client = deps.acp;
  const connected = client.getConnectedProviders();
  const meta = rt.contextInfo();
  const ctx100 = meta?.contextUsagePercentage;
  const totalModels = client.availableModels.length;
  const totalProviders = connected.length;

  const lines = [
    "\u{1F4CA} Usage & providers",
    totalProviders > 0 ? `\u2705 Connected: ${connected.join(", ")}` : "\u274C No providers connected \u2014 use /connect to add an API key",
    "",
    `\u{1F4E6} Available models: ${totalModels}`,
    `\u{1F9F5} Session: ${rt.sessionId ? rt.sessionId.slice(0, 8) : "none"}`,
    `\u{1F9E9} Model: ${rt.model || "default"}`,
    `\u{1F4CA} Context used: ${ctx100 !== undefined ? `${ctx100.toFixed(0)}%` : "\u2014"}`,
    `\u{1F501} Turns this session: ${rt.turns}`,
    meta?.credits !== undefined ? `\u{1FA99} Cost: $${meta.credits.toFixed(4)}` : "",
    "",
    "Use /connect <provider> <api_key> to connect a provider.",
    "Use /models to browse and select a model.",
  ].filter(Boolean);

  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, lines.join("\n"));
}

export function registerUsage(bot: Bot, deps: BotDeps): void {
  bot.command("usage", (ctx) => showUsage(ctx, deps));
}

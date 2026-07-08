/**
 * /connect — manage provider connections (API keys).
 *
 *   /connect                 List all providers + connection status
 *   /connect <provider>      Show auth methods for a provider
 *   /connect <provider> <key>  Set API key and connect
 *
 * Examples:
 *   /connect anthropic sk-ant-...
 *   /connect openai sk-...
 *   /connect openrouter sk-or-...
 */
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotDeps } from "../deps.js";

export async function showConnect(ctx: Context, deps: BotDeps): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const client = deps.acp;
  const parts = ctx.match ? String(ctx.match).trim().split(/\s+/) : [];

  // /connect <provider> <key>  → set API key
  if (parts.length >= 2) {
    const providerId = parts[0]!.toLowerCase();
    const apiKey = parts.slice(1).join(" ").trim();
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(ctx, `\u{1F510} Connecting ${providerId}\u2026`);
    const ok = await client.setProviderApiKey(providerId, apiKey);
    if (ok) {
      await ctx.reply(`\u2705 ${providerId} connected! Use /models to pick a model.`);
    } else {
      await ctx.reply(`\u274C Failed to connect ${providerId}. Check the API key and provider ID.`);
    }
    // Delete the message containing the API key for security
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore */
    }
    return;
  }

  // /connect <provider>  → show auth info
  if (parts.length === 1) {
    const providerId = parts[0]!.toLowerCase();
    const authMethods = await client.getProviderAuth();
    const methods = authMethods[providerId];
    const connected = client.isProviderConnected(providerId);
    const status = connected ? "\u2705 Connected" : "\u274C Not connected";
    const lines = [
      `\u{1F510} Provider: ${providerId}`,
      `Status: ${status}`,
      "",
      methods && methods.length
        ? `Auth methods: ${methods.map((m) => `${m.label} (${m.type})`).join(", ")}`
        : "Auth: API key",
      "",
      `To connect: /connect ${providerId} <your-api-key>`,
    ];
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(ctx, lines.join("\n"));
    return;
  }

  // /connect  → list all providers
  const models = client.availableModels;
  const connected = client.getConnectedProviders();
  // Group models by provider
  const byProvider = new Map<string, number>();
  for (const m of models) {
    const pid = m.modelId.split("/")[0] ?? "?";
    byProvider.set(pid, (byProvider.get(pid) ?? 0) + 1);
  }

  const lines = [
    "\u{1F510} Providers",
    "",
    ...[...byProvider.entries()].map(([pid, count]) => {
      const isConnected = connected.includes(pid);
      const icon = isConnected ? "\u2705" : "\u26A0\uFE0F";
      return `${icon} ${pid} \u2014 ${count} models${isConnected ? "" : " (not connected)"}`;
    }),
    "",
    `Connected: ${connected.length} / ${byProvider.size} providers`,
    "",
    "Connect with: /connect <provider> <api-key>",
    "Example: /connect anthropic sk-ant-...",
  ];

  await deps.ephemeral.open(ctx);
  const kb = new InlineKeyboard();
  // Show top 8 providers as buttons
  let i = 0;
  for (const pid of byProvider.keys()) {
    if (i >= 8) break;
    const isConnected = connected.includes(pid);
    kb.text(`${isConnected ? "\u2705" : "\u26A0\uFE0F"} ${pid}`, `connect:${pid}`);
    if (i % 2 === 1) kb.row();
    i++;
  }
  await deps.ephemeral.reply(ctx, lines.join("\n"), { replyMarkup: kb });
}

export function registerConnect(bot: Bot, deps: BotDeps): void {
  bot.command("connect", (ctx) => showConnect(ctx, deps));
  bot.callbackQuery(/^connect:(.+)$/, async (ctx) => {
    const providerId = ctx.match![1]!;
    const client = deps.acp;
    const connected = client.isProviderConnected(providerId);
    const authMethods = await client.getProviderAuth();
    const methods = authMethods[providerId];
    const lines = [
      `\u{1F510} ${providerId}`,
      `Status: ${connected ? "\u2705 Connected" : "\u274C Not connected"}`,
      "",
      methods && methods.length
        ? `Auth: ${methods.map((m) => `${m.label} (${m.type})`).join(", ")}`
        : "Auth: API key",
      "",
      `Connect: /connect ${providerId} <api-key>`,
    ];
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(lines.join("\n")).catch(() => {});
  });
}

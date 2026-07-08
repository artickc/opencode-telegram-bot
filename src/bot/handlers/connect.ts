/**
 * /connect — provider management panel.
 *
 *   /connect                      Providers panel (connected + available)
 *   /connect <provider> <key>     Set API key and connect
 *   /connect <search>             Filter available providers
 *
 * Menu "Providers" button → same panel.
 *
 * The panel shows:
 *  ✓ Connected providers with ❌ disconnect buttons
 *  ⚠ Available providers with tap-to-connect
 *  Pagination for long provider lists
 *  Per-provider detail: model count, auth methods
 */
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotDeps } from "../deps.js";

const PROVIDERS_PER_PAGE = 10;

/** Providers panel — reachable from menu button or /connect command. */
export async function showProvidersPanel(ctx: Context, deps: BotDeps, search = "", page = 0, isEdit = false): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const client = deps.acp;
  await client.refreshDiscovery();

  const connected = client.getConnectedProviders();
  const allProviderIds = new Set<string>();
  const providerModelCounts = new Map<string, number>();
  const providerNames = new Map<string, string>();

  for (const m of client.availableModels) {
    const pid = m.modelId.split("/")[0] ?? "";
    allProviderIds.add(pid);
    providerModelCounts.set(pid, (providerModelCounts.get(pid) ?? 0) + 1);
    if (!providerNames.has(pid) && m.description) {
      // Extract provider name from description (before the ✓ or (not connected))
      const name = m.description.replace(/\s*[✓✗⚠].*/u, "").trim();
      if (name) providerNames.set(pid, name);
    }
  }

  // Build the keyboard
  const kb = new InlineKeyboard();

  // ── Connected section ──────────────────────────────────────────────────
  if (connected.length > 0) {
    kb.text(`✅ Connected (${connected.length})`, "noop").row();
    for (const pid of connected) {
      const count = providerModelCounts.get(pid) ?? 0;
      const name = providerNames.get(pid) ?? pid;
      kb.text(`❌ ${name} (${count} models)`, `prov:disconnect:${pid}`).row();
    }
    kb.row();
  }

  // ── Available (not connected) section ──────────────────────────────────
  const available = [...allProviderIds]
    .filter((pid) => !connected.includes(pid))
    .filter((pid) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return pid.toLowerCase().includes(q) || (providerNames.get(pid) ?? "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.localeCompare(b));

  if (available.length > 0) {
    const totalAvail = available.length;
    const totalPages = Math.ceil(totalAvail / PROVIDERS_PER_PAGE);
    const startIdx = page * PROVIDERS_PER_PAGE;
    const pageItems = available.slice(startIdx, startIdx + PROVIDERS_PER_PAGE);

    kb.text(`🔌 Available (${totalAvail}${search ? ` matching "${search}"` : ""})`, "noop").row();

    for (const pid of pageItems) {
      const count = providerModelCounts.get(pid) ?? 0;
      const name = providerNames.get(pid) ?? pid;
      // Show provider name + model count + connect hint
      kb.text(`🔗 ${name} (${count})`, `prov:detail:${pid}`).row();
    }

    // Pagination
    if (totalPages > 1) {
      const navBtns: string[] = [];
      if (page > 0) navBtns.push(`prov:page:${page - 1}${search ? ":" + search : ""}`);
      navBtns.push(`ℹ ${page + 1}/${totalPages}`);
      if (page < totalPages - 1) navBtns.push(`prov:page:${page + 1}${search ? ":" + search : ""}`);
      for (const cb of navBtns) {
        if (cb.includes("ℹ")) {
          kb.text(cb, "noop");
        } else if (cb.startsWith("prov:page:0") && page === 1) {
          kb.text("⬅ Prev", cb);
        } else {
          kb.text("Next ➡", cb);
        }
      }
      kb.row();
    }
  }

  if (connected.length === 0 && available.length === 0) {
    const msg = "No providers found. Make sure OpenCode is running.\nTry: /connect anthropic <your-api-key>";
    if (isEdit) {
      await ctx.editMessageText(msg).catch(() => {});
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  kb.text("🔄 Refresh", "prov:refresh");

  const lines = [
    "🔌 Providers",
    "",
    `✅ Connected: ${connected.length}`,
    connected.length > 0 ? connected.map((p) => `  • ${providerNames.get(p) ?? p}`).join("\n") : "  (none — connect one to start)",
    "",
    available.length > 0 ? `🔌 Available: ${available.length}` : "",
    "",
    "💡 To connect: tap a provider above, or use:",
    "/connect <provider> <api-key>",
  ].filter(Boolean);

  if (isEdit) {
    await ctx.editMessageText(lines.join("\n"), { reply_markup: kb }).catch(() => {});
  } else {
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  }
}

export function registerConnect(bot: Bot, deps: BotDeps): void {
  // /connect command — either set key directly or open panel
  bot.command("connect", async (ctx) => {
    const parts = ctx.match ? String(ctx.match).trim().split(/\s+/) : [];

    // /connect <provider> <key> → set API key
    if (parts.length >= 2) {
      const providerId = parts[0]!.toLowerCase();
      const apiKey = parts.slice(1).join(" ").trim();
      await ctx.replyWithChatAction("typing").catch(() => {});
      await ctx.reply(`🔑 Connecting ${providerId}…`);
      const ok = await deps.acp.setProviderApiKey(providerId, apiKey);
      if (ok) {
        await ctx.reply(`✅ ${providerId} connected!\nUse /model to pick a model.`);
      } else {
        await ctx.reply(`❌ Failed to connect ${providerId}. Check the API key.`);
      }
      // Delete the message with the API key for security
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      return;
    }

    // /connect <search> or /connect → open panel
    const search = parts.length === 1 ? parts[0]! : "";
    await showProvidersPanel(ctx, deps, search);
  });

  // Provider detail view
  bot.callbackQuery(/^prov:detail:(.+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const client = deps.acp;
    const isConnected = client.isProviderConnected(pid);
    const models = client.availableModels.filter((m) => m.modelId.startsWith(pid + "/"));
    const authMethods = await client.getProviderAuth();
    const methods = authMethods[pid];

    const lines = [
      `🔌 ${pid}`,
      `Status: ${isConnected ? "✅ Connected" : "⚠️ Not connected"}`,
      `Models: ${models.length}`,
      "",
      methods && methods.length
        ? `Auth: ${methods.map((m) => `${m.label} (${m.type})`).join(", ")}`
        : "Auth: API key",
      "",
      isConnected
        ? "❌ Disconnect with the button below."
        : `To connect:\n/connect ${pid} <your-api-key>`,
    ];

    const kb = new InlineKeyboard();
    if (isConnected) {
      kb.text(`❌ Disconnect ${pid}`, `prov:disconnect:${pid}`).row();
    } else {
      kb.text("⬅ Back to providers", "prov:page:0").row();
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(lines.join("\n"), { reply_markup: kb }).catch(() => {});
  });

  // Disconnect a provider
  bot.callbackQuery(/^prov:disconnect:(.+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const ok = await deps.acp.disconnectProvider(pid);
    await ctx.answerCallbackQuery({ text: ok ? `✅ ${pid} disconnected` : `❌ Failed` });
    await showProvidersPanel(ctx, deps, "", 0, true);
  });

  // Pagination
  bot.callbackQuery(/^prov:page:(\d+)(?::(.+))?$/, async (ctx) => {
    const page = Number(ctx.match![1]);
    const search = ctx.match![2] ?? "";
    await ctx.answerCallbackQuery();
    await showProvidersPanel(ctx, deps, search, page, true);
  });

  // Refresh
  bot.callbackQuery("prov:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🔄 Refreshed" });
    await showProvidersPanel(ctx, deps, "", 0, true);
  });

  // Noop button (section headers)
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}

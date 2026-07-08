/**
 * System commands: /queue /clearqueue /model /models /restart.
 *
 * /model        → paginated browser of all available models (inline keyboard)
 * /model <str>  → filtered list (models whose id/name/provider match)
 * /models       → alias for /model
 */
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotDeps } from "../deps.js";

const MODELS_PER_PAGE = 12;

export function registerSystem(bot: Bot, deps: BotDeps): void {
  bot.command("queue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Queue is empty. Send a message while I'm busy, or use /btw <text>.");
      return;
    }
    await ctx.reply(`\u{1F4E5} ${rt.queueLength} follow-up(s) queued. They run automatically after the current turn, or use /flush.`);
  });

  bot.command("clearqueue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const n = rt.clearQueue();
    await ctx.reply(n > 0 ? `\u{1F5D1} Cleared ${n} queued message(s).` : "Queue was already empty.");
  });

  // /model and /models — browse, search, and select models
  bot.command(["model", "models"], async (ctx) => {
    const query = (ctx.match || "").toString().trim();
    const client = deps.acp;
    await client.refreshDiscovery();

    if (client.availableModels.length === 0) {
      await ctx.reply("No models found. Use /connect <provider> <api-key> to connect a provider first.");
      return;
    }

    // If the query exactly matches a known modelId, set it directly.
    if (query && client.hasModel(query)) {
      const rt = deps.registry.get(ctx.chat.id);
      if (!rt.sessionId) { await ctx.reply("No active session. Send a message first."); return; }
      const res = await rt.setModelPref(query);
      await ctx.reply(res.ok ? `\u2705 Model: \`${query}\`` : `\u26A0\uFE0F ${res.error}`, { parse_mode: res.ok ? "Markdown" : undefined });
      return;
    }

    await showModelPicker(ctx, deps, query, 0);
  });

  bot.callbackQuery(/^models:page:(\d+)(?::(.+))?$/, async (ctx) => {
    const page = Number(ctx.match![1]);
    const search = ctx.match![2] ?? "";
    await ctx.answerCallbackQuery();
    await showModelPicker(ctx, deps, search, page, true);
  });

  bot.callbackQuery(/^models:set:(.+)$/, async (ctx) => {
    const modelId = ctx.match![1]!.replace(/_fg_/g, "/");
    const rt = deps.registry.get(ctx.chat!.id);
    if (!rt.sessionId) { await ctx.answerCallbackQuery({ text: "No active session." }); return; }
    const res = await rt.setModelPref(modelId);
    await ctx.answerCallbackQuery({ text: res.ok ? `\u2705 ${modelId}` : `\u274C ${res.error}` });
    if (res.ok) await ctx.editMessageText(`\u2705 Model set to \`${modelId}\`\nUse /model to change again.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("models:clear", async (ctx) => {
    const rt = deps.registry.get(ctx.chat!.id);
    await rt.setModelPref("");
    await ctx.answerCallbackQuery({ text: "\u2705 Default model" });
    await ctx.editMessageText(`\u2705 Model: **default** (agent's choice)\nUse /model to pick a specific one.`);
  });

  bot.command("restart", async (ctx) => {
    await ctx.reply("\u{1F501} Restarting the OpenCode agent\u2026");
    try {
      await deps.acp.restart();
      await ctx.reply("\u2705 OpenCode agent restarted. Your session will re-bind on the next message.");
    } catch (err) {
      await ctx.reply(`\u274C Restart failed: ${(err as Error).message}`);
    }
  });
}

/**
 * Render the paginated model picker as an inline keyboard.
 * Connected providers' models are sorted first.
 */
async function showModelPicker(
  ctx: Context,
  deps: BotDeps,
  search: string,
  page: number,
  isEdit = false,
): Promise<void> {
  const client = deps.acp;
  const rt = deps.registry.get(ctx.chat?.id ?? 0);
  const current = rt.model || client.currentModelId || "";
  const connected = new Set(client.getConnectedProviders());

  // Filter by search query
  let models = client.availableModels;
  if (search) {
    const q = search.toLowerCase();
    models = models.filter(
      (m) => m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q),
    );
  }

  if (models.length === 0) {
    const msg = search ? `No models match "${search}".` : "No models available. Use /connect first.";
    if (isEdit) await ctx.editMessageText?.(msg);
    else await ctx.reply(msg);
    return;
  }

  // Sort: connected first, then alphabetical
  models = [...models].sort((a, b) => {
    const ac = connected.has(a.modelId.split("/")[0] ?? "") ? 0 : 1;
    const bc = connected.has(b.modelId.split("/")[0] ?? "") ? 0 : 1;
    return ac - bc || a.modelId.localeCompare(b.modelId);
  });

  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
  const startIdx = page * MODELS_PER_PAGE;
  const pageModels = models.slice(startIdx, startIdx + MODELS_PER_PAGE);

  const kb = new InlineKeyboard();

  // Group by provider within the page for cleaner display
  let lastProvider = "";
  for (const m of pageModels) {
    const pid = m.modelId.split("/")[0] ?? "";
    if (pid !== lastProvider) {
      lastProvider = pid;
      const isConn = connected.has(pid);
      kb.text(`${isConn ? "\u2705" : "\u26A0\uFE0F"} ${pid.toUpperCase()}`, `connect:${pid}`).row();
    }
    const isActive = m.modelId === current;
    const cbData = `models:set:${m.modelId.replace(/\//g, "_fg_")}`;
    // Truncate name to fit callback data limit (64 bytes)
    const displayName = m.name.length > 40 ? m.name.slice(0, 37) + "\u2026" : m.name;
    kb.text(`${isActive ? "\u25B6 " : "   "}${displayName}`, cbData).row();
  }

  // Pagination controls
  if (totalPages > 1) {
    const navRow: string[] = [];
    if (page > 0) navRow.push(`models:page:${page - 1}${search ? ":" + search : ""}`);
    navRow.push(`\u2139 ${page + 1}/${totalPages} (${models.length})`);
    if (page < totalPages - 1) navRow.push(`models:page:${page + 1}${search ? ":" + search : ""}`);
    navRow.forEach((d) => kb.text(d.includes("\u2139") ? d : (page > 0 && d === navRow[0] ? "\u2B05 Prev" : "Next \u27A1"), d));
    kb.row();
  }

  kb.text("Default (auto)", "models:clear");

  const header = search
    ? `\u{1F9E9} Models matching "${search}" (${models.length})\nCurrent: ${current || "default"}`
    : `\u{1F9E9} Models (${models.length})\nCurrent: ${current || "default"}`;

  if (isEdit) {
    await ctx.editMessageText(header, { reply_markup: kb });
  } else {
    await ctx.reply(header, { reply_markup: kb });
  }
}

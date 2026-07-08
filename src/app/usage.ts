/**
 * Account info via opencode config. OpenCode uses provider API keys
 * configured in opencode.json, so /usage shows configured providers +
 * live session context usage.
 */
import type { OpenCodeClient } from "../opencode/client.js";

export interface AccountInfo {
  accountType?: string;
  email?: string;
  region?: string;
  startUrl?: string;
  /** Configured providers count. */
  providers?: number;
  /** Current model in use. */
  model?: string;
}

export class UsageService {
  constructor(private readonly client: OpenCodeClient) {}

  async account(): Promise<AccountInfo | undefined> {
    try {
      return {
        accountType: "opencode",
        providers: this.client.availableModels.length,
        model: this.client.currentModelId,
      };
    } catch {
      return undefined;
    }
  }

  async summary(sessionId?: string): Promise<string> {
    const acct = await this.account();
    const parts: string[] = [];
    if (acct?.model) parts.push(`Model: ${acct.model}`);
    if (acct?.providers !== undefined) parts.push(`Providers: ${acct.providers}`);
    const meta = this.client.metadataFor(sessionId);
    if (meta?.contextUsagePercentage !== undefined) {
      parts.push(`Context: ${meta.contextUsagePercentage}%`);
    }
    if (meta?.credits !== undefined) {
      parts.push(`Cost: $${meta.credits.toFixed(4)}`);
    }
    return parts.join(" \u00B7 ") || "No usage data available.";
  }
}

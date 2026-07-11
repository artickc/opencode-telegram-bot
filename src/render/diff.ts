/**
 * Render a unified diff for a file edit as RAW markdown (a ```diff fenced
 * block). Escaping/splitting is handled downstream by the markdown converter.
 *
 * Long edits are truncated *logically*: keep the first and last change hunks,
 * drop middle hunks with a summary, and cap total lines so Telegram stays
 * readable without losing the shape of the change.
 */
import { structuredPatch } from "diff";

export interface DiffInput {
  path: string;
  oldText: string | null | undefined;
  newText: string | null | undefined;
  maxLines: number;
}

export interface DiffResult {
  block: string; // raw ```diff fenced markdown, or ""
  added: number;
  removed: number;
  truncated: boolean;
}

/** Default max lines shown in a tool card; callers may override via config. */
export const DEFAULT_DIFF_MAX_LINES = 40;

export function renderUnifiedDiff(input: DiffInput): DiffResult {
  const oldText = input.oldText ?? "";
  const newText = input.newText ?? "";
  if (oldText === newText) return { block: "", added: 0, removed: 0, truncated: false };

  const maxLines = Math.max(8, input.maxLines || DEFAULT_DIFF_MAX_LINES);
  const patch = structuredPatch(input.path, input.path, oldText, newText, "", "", { context: 2 });

  // Flatten hunks, counting stats.
  type Line = { text: string; kind: "hunk" | "add" | "del" | "ctx" };
  const all: Line[] = [];
  let added = 0;
  let removed = 0;

  for (const hunk of patch.hunks) {
    all.push({
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      kind: "hunk",
    });
    for (const l of hunk.lines) {
      if (l.startsWith("\\")) continue; // drop "\ No newline at end of file"
      if (l.startsWith("+")) {
        added++;
        all.push({ text: l, kind: "add" });
      } else if (l.startsWith("-")) {
        removed++;
        all.push({ text: l, kind: "del" });
      } else {
        all.push({ text: l, kind: "ctx" });
      }
    }
  }
  if (all.length === 0) return { block: "", added, removed, truncated: false };

  // Short enough — show as-is.
  if (all.length <= maxLines) {
    return {
      block: "```diff\n" + all.map((l) => l.text).join("\n") + "\n```",
      added,
      removed,
      truncated: false,
    };
  }

  // Logical truncation: keep a head of change-heavy lines and a tail, with a
  // middle summary. Prefer keeping +/− lines over pure context.
  const headBudget = Math.max(4, Math.floor(maxLines * 0.55));
  const tailBudget = Math.max(3, maxLines - headBudget - 1);

  const head = pickImportant(all, headBudget, "start");
  const tail = pickImportant(all, tailBudget, "end");

  // Avoid overlapping if the file is only slightly over the limit.
  const headEnd = head.endIndex;
  const tailStart = tail.startIndex;
  let shown: string[];
  let note: string;
  if (tailStart <= headEnd) {
    shown = all.slice(0, maxLines).map((l) => l.text);
    note = `\n… +${all.length - maxLines} more lines`;
  } else {
    const mid = all.slice(headEnd + 1, tailStart);
    const midAdd = mid.filter((l) => l.kind === "add").length;
    const midDel = mid.filter((l) => l.kind === "del").length;
    const midCtx = mid.filter((l) => l.kind === "ctx" || l.kind === "hunk").length;
    const parts: string[] = [];
    if (midAdd) parts.push(`+${midAdd}`);
    if (midDel) parts.push(`-${midDel}`);
    if (midCtx) parts.push(`${midCtx} context`);
    const summary = parts.length ? parts.join(" · ") : `${mid.length} lines`;
    shown = [
      ...all.slice(0, headEnd + 1).map((l) => l.text),
      `… (${summary} omitted) …`,
      ...all.slice(tailStart).map((l) => l.text),
    ];
    note = "";
  }

  // Soft-cap absolute line width so a single huge line doesn't blow the bubble.
  const capped = shown.map((l) => (l.length > 200 ? l.slice(0, 197) + "…" : l));

  return {
    block: "```diff\n" + capped.join("\n") + note + "\n```",
    added,
    removed,
    truncated: true,
  };
}

/** Pick up to `budget` lines from the start or end, preferring change lines. */
function pickImportant(
  lines: Array<{ text: string; kind: string }>,
  budget: number,
  side: "start" | "end",
): { endIndex: number; startIndex: number } {
  if (side === "start") {
    let i = 0;
    let kept = 0;
    // Always take the first hunk header + following lines until budget.
    while (i < lines.length && kept < budget) {
      i++;
      kept++;
    }
    return { endIndex: i - 1, startIndex: 0 };
  }
  let i = lines.length - 1;
  let kept = 0;
  while (i >= 0 && kept < budget) {
    i--;
    kept++;
  }
  return { endIndex: lines.length - 1, startIndex: i + 1 };
}

/** Compact "+12 −3" stats badge (empty when no changes). */
export function diffStatBadge(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join(" ");
}

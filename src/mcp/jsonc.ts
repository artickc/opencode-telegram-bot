/**
 * Minimal JSONC → JSON parser for OpenCode config files.
 *
 * OpenCode's `opencode.json` is often *JSONC*: block/line comments and trailing
 * commas are allowed. Node's `JSON.parse` rejects those, which made /mcp show
 * "0 servers" even when dozens were configured.
 *
 * No dependency — strips comments + trailing commas then uses JSON.parse.
 */

/** Parse a JSON or JSONC document into a value. Throws on real syntax errors. */
export function parseJsonc<T = unknown>(text: string): T {
  const stripped = stripJsonc(text);
  return JSON.parse(stripped) as T;
}

/** Best-effort parse; returns undefined on failure. */
export function tryParseJsonc<T = unknown>(text: string): T | undefined {
  try {
    return parseJsonc<T>(text);
  } catch {
    return undefined;
  }
}

/**
 * Remove // and /* *\/ comments and trailing commas before `}` / `]`,
 * respecting string literals so `http://…` and `","` are never touched.
 */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  let escape = false;

  while (i < n) {
    const c = input[i]!;

    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Line comment
    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < n && input[i] !== "\n" && input[i] !== "\r") i++;
      continue;
    }

    // Block comment
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      // Preserve a newline so line numbers stay roughly stable for errors.
      out += " ";
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    // Trailing comma: `,` followed by optional whitespace then `}` or `]`.
    if (c === ",") {
      let j = i + 1;
      while (j < n && /[ \t\r\n]/.test(input[j]!)) j++;
      if (j < n && (input[j] === "}" || input[j] === "]")) {
        i++; // skip the comma
        continue;
      }
    }

    out += c;
    i++;
  }

  return out;
}

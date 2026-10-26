// Minimal YAML-subset frontmatter parser/serializer for memport/1 item
// files and for reading tool-native frontmatter (Claude topic files,
// Cursor .mdc rules).
//
// Design notes (see FORMAT.md):
// - Parsing is TOLERANT: unparseable lines are ignored (mirroring Claude
//   Code, which loads a file as if it had no frontmatter when parsing
//   fails). Strictness lives in validate(), which checks required fields.
// - Serialization is DEFENSIVE: every string value is emitted JSON-quoted,
//   so a value can never contain a bare `---` line, a `: ` mapping break,
//   or a comment marker. Body text is never interpreted: parsing splits
//   on the FIRST `---` line and the NEXT `---` line only, so bodies
//   containing `---` lines or `<!-- END MEMPORT -->` markers parse safely.
// - The body is preserved byte-exactly (modulo the line-ending handling
//   described below); only the frontmatter block is interpreted.
// - Supported value shapes: plain scalars, double/single-quoted scalars,
//   `true`/`false` booleans, block lists (`- item`), inline lists
//   (`[a, b]`), literal blocks (`|`). Numbers stay strings (v1 has no
//   numeric frontmatter fields). Duplicate keys: last wins.

export interface ParsedFrontmatter {
  /** True when the file opened with a `---` line. */
  hadFrontmatter: boolean;
  /** Parsed key/value pairs (unknown keys kept, not rejected). */
  data: Record<string, unknown>;
  /** Body text, byte-exact apart from the consumed delimiter lines. */
  body: string;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Split text into lines, keeping each line's end offset for slicing. */
function splitLines(text: string): { line: string; start: number; end: number }[] {
  const out: { line: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      out.push({ line: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to literal handling.
    }
    return v.replace(/^"/, "").replace(/"$/, "");
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return splitInlineList(inner).map((s) => {
      const p = parseScalar(s);
      return typeof p === "string" ? p : String(p);
    });
  }
  return v;
}

function splitInlineList(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ",") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== "" || parts.length > 0) parts.push(cur.trim());
  return parts.filter((p) => p !== "");
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = splitLines(text);
  if (lines.length === 0 || stripCr(lines[0].line) !== "---") {
    return { hadFrontmatter: false, data: {}, body: text };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (stripCr(lines[i].line) === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Unterminated frontmatter: treat the whole file as body. validate()
    // will reject bundle items missing required fields.
    return { hadFrontmatter: false, data: {}, body: text };
  }
  const data: Record<string, unknown> = {};
  const fmLines = lines.slice(1, closeIdx).map((l) => stripCr(l.line));
  for (let i = 0; i < fmLines.length; i++) {
    const raw = fmLines[i];
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!m) continue; // unparseable line: ignored, never fatal
    const key = m[1];
    const rest = m[2];
    if (rest === "" || rest === null) {
      // Block list or literal block on following lines.
      const items: string[] = [];
      let j = i + 1;
      let literal: string[] | null = null;
      if (j < fmLines.length && /^\s*\|[-+]?\s*$/.test(fmLines[j])) {
        literal = [];
        j++;
        while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) {
          literal.push(fmLines[j].replace(/^\s+/, ""));
          j++;
        }
      } else {
        while (j < fmLines.length) {
          const lm = /^\s*-\s+(.*)$/.exec(fmLines[j]);
          if (!lm) break;
          const p = parseScalar(lm[1]);
          items.push(typeof p === "string" ? p : String(p));
          j++;
        }
      }
      if (literal !== null) {
        data[key] = literal.join("\n");
        i = j - 1;
      } else if (items.length > 0) {
        data[key] = items;
        i = j - 1;
      } else {
        data[key] = null;
      }
      continue;
    }
    if (/^\|[-+]?\s*$/.test(rest)) {
      // Literal block on the same line: `key: |`.
      const literal: string[] = [];
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) {
        literal.push(fmLines[j].replace(/^\s+/, ""));
        j++;
      }
      data[key] = literal.join("\n");
      i = j - 1;
      continue;
    }
    data[key] = parseScalar(rest);
  }
  // Body = everything after the closing delimiter line's newline.
  const closeLine = lines[closeIdx];
  const bodyStart = closeLine.end + 1 <= text.length ? closeLine.end + 1 : text.length;
  return { hadFrontmatter: true, data, body: text.slice(bodyStart) };
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    // Block list, one JSON-quoted item per line.
    return "\n" + value.map((v) => `- ${JSON.stringify(String(v))}`).join("\n");
  }
  return JSON.stringify(String(value));
}

/**
 * Serialize frontmatter + body. Keys are emitted in insertion order.
 * Null/undefined values are OMITTED (readers treat missing as null).
 * The body is written verbatim after the closing delimiter.
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const serialized = serializeValue(value);
    if (serialized.startsWith("\n")) {
      lines.push(`${key}:${serialized}`);
    } else {
      lines.push(`${key}: ${serialized}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

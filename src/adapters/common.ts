// Shared helpers for the tool adapters (read-only; adapters never write
// to tool stores). See FORMAT.md for title and scope conventions.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "../frontmatter.ts";
import { mintItem, type ItemKind, type ItemOrigin, type MemportItem } from "../format.ts";

export interface CollectResult {
  items: MemportItem[];
  warnings: string[];
  /** Absolute paths actually read (manifest provenance notes). */
  sources: string[];
  /** Cursor: plain .md files in .cursor/rules/ ignored by Cursor itself. */
  ignoredMd?: number;
  /** Codex: combined chain size in bytes (global + project files). */
  chainBytes?: number;
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function listFiles(dir: string, suffix: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(suffix))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** Filename stem with dashes/underscores turned into spaces. */
export function humanizeStem(file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  return base.replace(/[-_]+/g, " ").trim() || base;
}

/** Project-dir name derivation for ~/.claude/projects/<name>/memory:
 *  the working-directory path with non-alphanumerics replaced by dashes
 *  (the same rule Claude uses for transcript folders). Documented
 *  approximation: if the derived directory does not exist, auto-memory
 *  is skipped with a warning rather than guessed across projects. */
export function claudeProjectDirName(projectDir: string): string {
  return projectDir.replace(/[^A-Za-z0-9]/g, "-");
}

export function makeRule(opts: {
  title: string;
  scope: "user" | "project";
  origin: ItemOrigin;
  sourceTool: string;
  sourcePath: string;
  sourceKind?: string | null;
  body: string;
  tags?: string[];
}): MemportItem {
  return mintItem({
    kind: "rule",
    title: opts.title,
    scope: opts.scope,
    origin: opts.origin,
    source_tool: opts.sourceTool,
    source_path: opts.sourcePath,
    source_kind: opts.sourceKind ?? null,
    body: opts.body,
    tags: opts.tags ?? [],
  });
}

/** Parse a markdown file's frontmatter leniently (see frontmatter.ts). */
export function readMarkdownWithFrontmatter(file: string): {
  text: string;
  data: Record<string, unknown>;
  body: string;
} {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(text);
  return { text, data: parsed.data, body: parsed.body };
}

export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

export function kindFromClaudeType(type: unknown): { kind: ItemKind; sourceKind: string } {
  switch (type) {
    case "user":
      return { kind: "preference", sourceKind: "claude:type:user" };
    case "feedback":
      return { kind: "preference", sourceKind: "claude:type:feedback" };
    case "project":
      return { kind: "decision", sourceKind: "claude:type:project" };
    case "reference":
      return { kind: "reference", sourceKind: "claude:type:reference" };
    case undefined:
    case null:
    case "":
      return { kind: "note", sourceKind: "claude:memory" };
    default:
      return { kind: "note", sourceKind: `claude:type:${String(type)}` };
  }
}

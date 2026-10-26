// Cursor adapter (read-only).
// Sources (assessment §1.4): project rules .cursor/rules/*.mdc
// (plain .md files in that directory are ignored by Cursor and are
// therefore ignored here, with a count), legacy .cursorrules, and repo
// AGENTS.md. Cursor User/Team Rules live in settings, not files, so
// user-scope import is a hard error. Cursor chat history has no
// documented on-disk location and is never read. Cursor's per-chat
// Memories feature was removed in 2.1.x: there is no learned store
// to import — rules are the only durable surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { MemportError } from "../format.ts";
import {
  humanizeStem,
  listFiles,
  listSymlinks,
  makeRule,
  readIfExists,
  readMarkdownWithFrontmatter,
  type CollectResult,
} from "./common.ts";

export interface CursorOptions {
  scope: "user" | "project";
  projectDir?: string;
}

function activationKind(data: Record<string, unknown>): string {
  if (data["alwaysApply"] === true) return "cursor:alwaysApply";
  const globs = data["globs"];
  if (typeof globs === "string" && globs.trim() !== "") return `cursor:globs:${globs}`;
  if (Array.isArray(globs) && globs.length > 0) {
    return `cursor:globs:${globs.filter((g) => typeof g === "string").join(",")}`;
  }
  if (typeof data["description"] === "string" && data["description"].trim() !== "") {
    return "cursor:description";
  }
  return "cursor:manual";
}

export function collectCursor(opts: CursorOptions): CollectResult {
  if (opts.scope === "user") {
    throw new MemportError(
      "Cursor user rules live in settings (User Rules / Team Rules), not in files — " +
        "v1 cannot import them. Import project rules with --scope project instead (see README FAQ).",
    );
  }
  const projectDir = opts.projectDir;
  if (!projectDir) throw new MemportError("Cursor project import requires --project <dir>");
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new MemportError(`project directory does not exist: ${projectDir}`);
  }
  const result: CollectResult = { items: [], warnings: [], sources: [], ignoredMd: 0 };
  const rulesDir = path.join(projectDir, ".cursor", "rules");
  for (const link of listSymlinks(rulesDir, ".mdc")) {
    result.warnings.push(`skipped symlinked file (not followed): ${link}`);
  }
  for (const file of listFiles(rulesDir, ".mdc")) {
    const { data, body } = readMarkdownWithFrontmatter(file);
    result.sources.push(file);
    result.items.push(
      makeRule({
        title: humanizeStem(file),
        scope: "project",
        origin: "human",
        sourceTool: "cursor",
        sourcePath: file,
        sourceKind: activationKind(data),
        body,
      }),
    );
  }
  // Plain .md files in .cursor/rules/ are ignored by Cursor's rules
  // system (no frontmatter) — ignored here too, with a count.
  result.ignoredMd = listFiles(rulesDir, ".md").length;
  if (result.ignoredMd > 0) {
    result.warnings.push(
      `${result.ignoredMd} plain .md file(s) in .cursor/rules/ ignored (Cursor ignores them too)`,
    );
  }
  const legacy = path.join(projectDir, ".cursorrules");
  const legacyText = readIfExists(legacy);
  if (legacyText !== null && legacyText.trim() !== "") {
    result.sources.push(legacy);
    result.items.push(
      makeRule({
        title: ".cursorrules",
        scope: "project",
        origin: "human",
        sourceTool: "cursor",
        sourcePath: legacy,
        sourceKind: "cursor:legacy",
        body: legacyText,
      }),
    );
  }
  const agents = path.join(projectDir, "AGENTS.md");
  const agentsText = readIfExists(agents);
  if (agentsText !== null && agentsText.trim() !== "") {
    result.sources.push(agents);
    result.items.push(
      makeRule({
        title: "AGENTS.md (repo)",
        scope: "project",
        origin: "human",
        sourceTool: "cursor",
        sourcePath: agents,
        sourceKind: "cursor:agents",
        body: agentsText,
      }),
    );
  }
  if (result.items.length === 0) {
    throw new MemportError(
      `no Cursor project rules found (looked for ${rulesDir}/*.mdc, ${legacy}, ${agents})`,
    );
  }
  return result;
}

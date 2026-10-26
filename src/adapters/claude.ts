// Claude Code adapter (read-only).
// Sources (assessment §1.2): CLAUDE.md layers (project, user,
// .claude/rules/), AGENTS.md is NOT imported here (it is Codex/Cursor
// surface; Claude reads it conditionally), auto-memory index + topic
// files. Transcripts are never parsed (internal, unstable format).

import * as fs from "node:fs";
import * as path from "node:path";
import { MemportError, mintItem, normalizeTitle, titleFromBody } from "../format.ts";
import {
  claudeHome,
  claudeProjectDirName,
  humanizeStem,
  kindFromClaudeType,
  listFiles,
  makeRule,
  readIfExists,
  readMarkdownWithFrontmatter,
  type CollectResult,
} from "./common.ts";

export interface ClaudeOptions {
  scope: "user" | "project";
  projectDir?: string;
  home?: string;
}

function importLayerFile(
  file: string,
  label: string,
  scope: "user" | "project",
  result: CollectResult,
): void {
  const text = readIfExists(file);
  if (text === null || text.trim() === "") return;
  result.sources.push(file);
  result.items.push(
    makeRule({
      title: label,
      scope,
      origin: "human",
      sourceTool: "claude",
      sourcePath: file,
      sourceKind: "claude:instruction",
      body: text,
    }),
  );
}

function importRulesDir(dir: string, scope: "user" | "project", result: CollectResult): void {
  for (const file of listFiles(dir, ".md")) {
    const { data, body } = readMarkdownWithFrontmatter(file);
    const paths = data["paths"];
    let sourceKind = "claude:rules";
    if (paths !== undefined && paths !== null) {
      const list = Array.isArray(paths)
        ? paths.filter((p) => typeof p === "string")
        : typeof paths === "string"
          ? paths.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      if (list.length > 0) sourceKind = `claude:rules:paths:${list.join(",")}`;
    }
    result.sources.push(file);
    result.items.push(
      makeRule({
        title: humanizeStem(file),
        scope,
        origin: "human",
        sourceTool: "claude",
        sourcePath: file,
        sourceKind,
        body,
      }),
    );
  }
}

function importAutoMemory(memoryDir: string, result: CollectResult): void {
  const indexFile = path.join(memoryDir, "MEMORY.md");
  const indexText = readIfExists(indexFile);
  const topicFiles = listFiles(memoryDir, ".md").filter((f) => path.basename(f) !== "MEMORY.md");
  const topicStems = new Set<string>();
  const topicTitles = new Set<string>();
  for (const file of topicFiles) {
    const { data, body } = readMarkdownWithFrontmatter(file);
    const { kind, sourceKind } = kindFromClaudeType(data["type"]);
    const title =
      typeof data["title"] === "string" && data["title"].trim() !== ""
        ? data["title"]
        : humanizeStem(file);
    topicStems.add(path.basename(file, ".md").toLowerCase());
    topicTitles.add(normalizeTitle(title));
    result.sources.push(file);
    result.items.push(
      mintItem({
        kind,
        title,
        scope: "project",
        origin: "agent-learned",
        source_tool: "claude",
        source_path: file,
        source_kind: sourceKind,
        body,
      }),
    );
  }
  if (indexText !== null) {
    result.sources.push(indexFile);
    for (const rawLine of indexText.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const lower = line.toLowerCase();
      // Skip lines that merely reference a topic file (the topic file
      // itself is the item); every other non-empty line becomes a note.
      let referencesTopic = false;
      for (const stem of topicStems) {
        if (lower.includes(stem)) {
          referencesTopic = true;
          break;
        }
      }
      if (!referencesTopic) {
        const text = line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
        if (text !== "" && !topicTitles.has(normalizeTitle(text))) {
          result.items.push(
            mintItem({
              kind: "note",
              title: titleFromBody(text).slice(0, 100),
              scope: "project",
              origin: "agent-learned",
              source_tool: "claude",
              source_path: indexFile,
              source_kind: "claude:memory:index",
              body: text,
            }),
          );
        }
      }
    }
  }
}

export function collectClaude(opts: ClaudeOptions): CollectResult {
  const home = opts.home ?? claudeHome();
  const result: CollectResult = { items: [], warnings: [], sources: [] };
  if (opts.scope === "user") {
    importLayerFile(path.join(home, "CLAUDE.md"), "CLAUDE.md (user)", "user", result);
    importRulesDir(path.join(home, "rules"), "user", result);
    if (result.items.length === 0) {
      throw new MemportError(
        `no Claude user memory found (looked for ${path.join(home, "CLAUDE.md")} and ${path.join(home, "rules")}/*.md)`,
      );
    }
    return result;
  }
  const projectDir = opts.projectDir;
  if (!projectDir) throw new MemportError("Claude project import requires --project <dir>");
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new MemportError(`project directory does not exist: ${projectDir}`);
  }
  importLayerFile(path.join(projectDir, "CLAUDE.md"), "CLAUDE.md (project)", "project", result);
  importLayerFile(path.join(projectDir, ".claude", "CLAUDE.md"), ".claude/CLAUDE.md", "project", result);
  importLayerFile(path.join(projectDir, "CLAUDE.local.md"), "CLAUDE.local.md", "project", result);
  importRulesDir(path.join(projectDir, ".claude", "rules"), "project", result);
  const memoryDir = path.join(home, "projects", claudeProjectDirName(projectDir), "memory");
  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    importAutoMemory(memoryDir, result);
  } else {
    result.warnings.push(`no Claude auto-memory directory at ${memoryDir} (skipped)`);
  }
  if (result.items.length === 0) {
    throw new MemportError(
      `no Claude project memory found in ${projectDir} (no CLAUDE.md layers, .claude/rules/, or auto-memory)`,
    );
  }
  return result;
}

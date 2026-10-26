// Codex adapter (read-only).
// Sources (assessment §1.3): AGENTS.md chain (global + project, first
// non-empty file per directory, 32 KiB budget) and ~/.codex/memories/
// markdown summaries (coarse notes only — the internal record layout is
// undocumented, and the vendor warns the store is generated state).
// Codex sessions and Chronicle output are never read.

import * as fs from "node:fs";
import * as path from "node:path";
import { MemportError, mintItem } from "../format.ts";
import {
  codexHome,
  humanizeStem,
  listFiles,
  makeRule,
  readIfExists,
  type CollectResult,
} from "./common.ts";

export interface CodexOptions {
  scope: "user" | "project";
  projectDir?: string;
  home?: string;
}

export const CODEX_CHAIN_BUDGET = 32768;
const FALLBACKS = [".cursorrules", "CLAUDE.md", "CONVENTIONS.md"];

/** First non-empty file in a directory per Codex's selection rules. */
export function pickChainFile(dir: string): { file: string; role: string } | null {
  const override = path.join(dir, "AGENTS.override.md");
  const agents = path.join(dir, "AGENTS.md");
  const oText = readIfExists(override);
  if (oText !== null && oText.trim() !== "") return { file: override, role: "codex:override" };
  const aText = readIfExists(agents);
  if (aText !== null && aText.trim() !== "") return { file: agents, role: "codex:agents" };
  for (const name of FALLBACKS) {
    const f = path.join(dir, name);
    const t = readIfExists(f);
    if (t !== null && t.trim() !== "") return { file: f, role: `codex:fallback:${name}` };
  }
  return null;
}

/** Repository root by walking up for a .git entry; null when none. */
function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function chainDirs(projectDir: string): string[] {
  const root = findGitRoot(projectDir);
  const resolved = path.resolve(projectDir);
  if (root === null) return [resolved];
  const rel = path.relative(root, resolved);
  const dirs = [root];
  if (rel !== "") {
    const parts = rel.split(path.sep);
    let cur = root;
    for (const part of parts) {
      cur = path.join(cur, part);
      dirs.push(cur);
    }
  }
  return dirs;
}

/** Chain files Codex would load: global file, then project chain files
 *  (root to leaf). Used for the 32 KiB budget computation on export. */
export function inspectCodexChain(projectDir: string | null, home: string): { file: string; role: string }[] {
  const files: { file: string; role: string }[] = [];
  const global = pickChainFile(home);
  if (global) files.push(global);
  if (projectDir) {
    for (const dir of chainDirs(projectDir)) {
      const picked = pickChainFile(dir);
      if (picked) files.push(picked);
    }
  }
  return files;
}

/** Total bytes of the given chain files (missing files count as 0). */
export function chainTotalBytes(files: { file: string }[]): number {
  let total = 0;
  for (const f of files) {
    try {
      total += Buffer.byteLength(fs.readFileSync(f.file, "utf8"), "utf8");
    } catch {
      // Missing file: contributes nothing.
    }
  }
  return total;
}

export function collectCodex(opts: CodexOptions): CollectResult {
  const home = opts.home ?? codexHome();
  const result: CollectResult = { items: [], warnings: [], sources: [] };
  let chainBytes = 0;

  // Global level: override wins, else AGENTS.md, first non-empty only.
  const global = pickChainFile(home);
  if (global) {
    const text = readIfExists(global.file) as string;
    chainBytes += Buffer.byteLength(text, "utf8");
    result.sources.push(global.file);
    result.items.push(
      makeRule({
        title: `AGENTS.md (global)`,
        scope: "user",
        origin: "human",
        sourceTool: "codex",
        sourcePath: global.file,
        sourceKind: global.role,
        body: text,
      }),
    );
  }

  if (opts.scope === "user") {
    // Codex memories summaries are user-level generated state.
    const memDir = path.join(home, "memories");
    for (const file of listFiles(memDir, ".md")) {
      const text = readIfExists(file);
      if (text === null || text.trim() === "") continue;
      result.sources.push(file);
      result.items.push(
        mintItem({
          kind: "note",
          title: humanizeStem(file),
          scope: "user",
          origin: "agent-learned",
          source_tool: "codex",
          source_path: file,
          source_kind: "codex:memory-summary",
          body: text,
          tags: ["codex-generated"],
        }),
      );
    }
    if (result.items.length === 0) {
      throw new MemportError(
        `no Codex user memory found (looked for ${path.join(home, "AGENTS.md")} and ${path.join(home, "memories")}/*.md)`,
      );
    }
    result.warnings.push(
      "Codex memories are vendor-generated state: imported summaries are coarse notes, not fine-grained entries.",
    );
    result.chainBytes = chainBytes;
    return result;
  }

  const projectDir = opts.projectDir;
  if (!projectDir) throw new MemportError("Codex project import requires --project <dir>");
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new MemportError(`project directory does not exist: ${projectDir}`);
  }
  const projectItems: CollectResult["items"] = [];
  for (const dir of chainDirs(projectDir)) {
    const picked = pickChainFile(dir);
    if (!picked) continue;
    const text = readIfExists(picked.file) as string;
    chainBytes += Buffer.byteLength(text, "utf8");
    result.sources.push(picked.file);
    const rel = path.relative(projectDir, dir);
    const label = rel === "" ? "AGENTS.md (project)" : `AGENTS.md (${rel})`;
    projectItems.push(
      makeRule({
        title: label,
        scope: "project",
        origin: "human",
        sourceTool: "codex",
        sourcePath: picked.file,
        sourceKind: picked.role,
        body: text,
      }),
    );
  }
  result.items.push(...projectItems);
  result.chainBytes = chainBytes;
  if (chainBytes > CODEX_CHAIN_BUDGET) {
    result.warnings.push(
      `Codex chain is ${chainBytes} bytes, over the ${CODEX_CHAIN_BUDGET} byte budget — Codex itself truncates it.`,
    );
  }
  if (result.items.length === 0) {
    throw new MemportError(
      `no Codex project memory found (no AGENTS.md chain files from ${projectDir} upward, no global file)`,
    );
  }
  return result;
}

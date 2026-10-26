import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectClaude } from "../src/adapters/claude.ts";
import { collectCodex } from "../src/adapters/codex.ts";
import { collectCursor } from "../src/adapters/cursor.ts";

const FIX = path.join(process.cwd(), "test", "fixtures");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memport-adapters-"));
}

describe("adapters: claude", () => {
  it("collects project layers + rules (4 rules)", () => {
    const r = collectClaude({
      scope: "project",
      projectDir: path.join(FIX, "claude-project"),
      home: path.join(FIX, "claude-home"),
    });
    assert.equal(r.items.length, 4);
    assert.ok(r.items.every((i) => i.meta.kind === "rule"));
    assert.deepEqual(
      r.items.map((i) => i.meta.title).sort(),
      [".claude/CLAUDE.md", "CLAUDE.md (project)", "deploy", "testing"].sort(),
    );
    assert.ok(r.warnings.some((w) => w.includes("auto-memory")));
  });

  it("collects user CLAUDE.md + user rules", () => {
    const r = collectClaude({ scope: "user", home: path.join(FIX, "claude-home") });
    assert.equal(r.items.length, 2);
    assert.ok(r.items.every((i) => i.meta.scope === "user"));
  });

  it("fails loudly on an empty project (never half-imports)", () => {
    const dir = tmpDir();
    assert.throws(
      () => collectClaude({ scope: "project", projectDir: dir, home: path.join(FIX, "claude-home") }),
      /no Claude project memory found/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("adapters: codex", () => {
  it("collects the global + project chain (2 rules)", () => {
    const r = collectCodex({
      scope: "project",
      projectDir: path.join(FIX, "codex-project"),
      home: path.join(FIX, "codex-home"),
    });
    assert.equal(r.items.length, 2);
    assert.ok((r.chainBytes ?? 0) > 0);
  });

  it("collects user memories summaries as coarse notes", () => {
    const r = collectCodex({ scope: "user", home: path.join(FIX, "codex-home") });
    const notes = r.items.filter((i) => i.meta.kind === "note");
    assert.equal(notes.length, 1);
    assert.ok((notes[0].meta.tags ?? []).includes("codex-generated"));
    assert.ok(r.warnings.some((w) => w.includes("coarse notes")));
  });

  it("warns when the chain exceeds the 32 KiB budget", () => {
    const home = tmpDir();
    const proj = tmpDir();
    fs.writeFileSync(path.join(home, "AGENTS.md"), "x".repeat(40000));
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "small");
    const r = collectCodex({ scope: "project", projectDir: proj, home });
    assert.ok(r.warnings.some((w) => w.includes("over the 32768 byte budget")));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });
});

describe("adapters: cursor", () => {
  it("collects .mdc rules + legacy + repo AGENTS.md, counts ignored .md", () => {
    const r = collectCursor({ scope: "project", projectDir: path.join(FIX, "cursor-project") });
    assert.equal(r.items.length, 6);
    assert.equal(r.ignoredMd, 1);
    const byTitle = new Map(r.items.map((i) => [i.meta.title, i.meta.source_kind]));
    assert.equal(byTitle.get("always"), "cursor:alwaysApply");
    assert.ok((byTitle.get("glob") ?? "").startsWith("cursor:globs:"));
    assert.equal(byTitle.get("desc"), "cursor:description");
    assert.equal(byTitle.get("manual"), "cursor:manual");
    assert.equal(byTitle.get(".cursorrules"), "cursor:legacy");
  });

  it("refuses user scope (User Rules live in settings, not files)", () => {
    assert.throws(
      () => collectCursor({ scope: "user", projectDir: path.join(FIX, "cursor-project") }),
      /live in settings/,
    );
  });
});

describe("adapters: fix round (subdirectory walk + symlink warnings)", () => {
  it("walks subdirectory CLAUDE.md files as project items with scope notes (F3)", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "Root rules.\n");
    fs.mkdirSync(path.join(dir, "docs", "guide"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "CLAUDE.md"), "Docs rules.\n");
    fs.writeFileSync(path.join(dir, "docs", "guide", "CLAUDE.md"), "Guide rules.\n");
    const r = collectClaude({ scope: "project", projectDir: dir, home: path.join(FIX, "claude-home") });
    const byTitle = new Map(r.items.map((i) => [i.meta.title, i.meta.source_kind]));
    assert.equal(byTitle.get("CLAUDE.md (project)"), "claude:instruction");
    assert.equal(byTitle.get("CLAUDE.md (docs)"), "claude:subdirectory");
    assert.equal(byTitle.get("CLAUDE.md (docs/guide)"), "claude:subdirectory");
    assert.ok(r.items.every((i) => i.meta.scope === "project"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns and skips symlinked tool-native files instead of following them (M12)", () => {
    const dir = tmpDir();
    const outside = tmpDir();
    // Claude: symlinked rule in .claude/rules/.
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "Root rules.\n");
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    const victim = path.join(outside, "victim.md");
    fs.writeFileSync(victim, "Outside content that must never be imported.\n");
    fs.symlinkSync(victim, path.join(dir, ".claude", "rules", "linked.md"));
    const claude = collectClaude({ scope: "project", projectDir: dir, home: path.join(FIX, "claude-home") });
    assert.ok(claude.warnings.some((w) => w.includes("skipped symlinked file") && w.includes("linked.md")));
    assert.ok(!claude.sources.some((s) => s.includes("linked.md")));
    assert.ok(!claude.items.some((i) => i.body.includes("Outside content")));
    // Cursor: symlinked .mdc rule.
    const proj = tmpDir();
    fs.mkdirSync(path.join(proj, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".cursor", "rules", "real.mdc"), "---\nalwaysApply: true\n---\nReal rule.\n");
    fs.symlinkSync(victim, path.join(proj, ".cursor", "rules", "linked.mdc"));
    const cursor = collectCursor({ scope: "project", projectDir: proj });
    assert.ok(cursor.warnings.some((w) => w.includes("skipped symlinked file") && w.includes("linked.mdc")));
    assert.ok(!cursor.items.some((i) => i.body.includes("Outside content")));
    assert.equal(cursor.items.length, 1);
    // Codex: symlinked memory summary.
    const home = tmpDir();
    fs.writeFileSync(path.join(home, "AGENTS.md"), "Global.\n");
    fs.mkdirSync(path.join(home, "memories"), { recursive: true });
    fs.writeFileSync(path.join(home, "memories", "real.md"), "Real summary.\n");
    fs.symlinkSync(victim, path.join(home, "memories", "linked.md"));
    const codex = collectCodex({ scope: "user", home });
    assert.ok(codex.warnings.some((w) => w.includes("skipped symlinked file") && w.includes("linked.md")));
    assert.ok(!codex.items.some((i) => i.body.includes("Outside content")));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

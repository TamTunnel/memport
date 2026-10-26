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

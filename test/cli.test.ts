import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBundle, mintItem } from "../src/format.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FIX = path.join(process.cwd(), "test", "fixtures");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memport-cli-"));
}

function run(
  args: string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function homesEnv(): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: path.join(FIX, "claude-home"),
    CODEX_HOME: path.join(FIX, "codex-home"),
  };
}

describe("cli end-to-end", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scan exits 0 and reports all three tools", () => {
    const r = run(["scan", "--project", path.join(FIX, "cursor-project")], homesEnv());
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("claude:") && r.stdout.includes("codex:") && r.stdout.includes("cursor:"));
  });

  it("bundle plan writes nothing; apply writes a valid bundle; re-bundle reuses ids", () => {
    const out = path.join(dir, "b");
    const plan = run(
      ["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", out],
      homesEnv(),
    );
    assert.equal(plan.code, 0);
    assert.ok(plan.stdout.includes("PLAN MODE"));
    assert.ok(!fs.existsSync(out));
    const applied = run(
      ["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", out, "--apply"],
      homesEnv(),
    );
    assert.equal(applied.code, 0);
    assert.ok(applied.stdout.includes("WROTE bundle"));
    assert.equal(run(["validate", out]).code, 0);
    const again = run(
      ["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", out, "--apply"],
      homesEnv(),
    );
    assert.ok(again.stdout.includes("reused ids: 6, new: 0"), again.stdout);
  });

  it("apply plan writes nothing; apply writes; second apply is a noop", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const bundleDir = path.join(dir, "b");
    run(["bundle", "--from", "claude", "--scope", "project", "--project", path.join(FIX, "claude-project"), "--out", bundleDir, "--apply"], homesEnv());
    const target = path.join(proj, ".cursor", "rules", "memport.mdc");
    const plan = run(["apply", "--bundle", bundleDir, "--to", "cursor", "--scope", "project", "--project", proj]);
    assert.equal(plan.code, 0);
    assert.ok(!fs.existsSync(target));
    const applied = run(["apply", "--bundle", bundleDir, "--to", "cursor", "--scope", "project", "--project", proj, "--apply"]);
    assert.equal(applied.code, 0);
    assert.ok(fs.existsSync(target));
    const again = run(["apply", "--bundle", bundleDir, "--to", "cursor", "--scope", "project", "--project", proj, "--apply"]);
    assert.ok(again.stdout.includes("action: noop"), again.stdout);
  });

  it("convert plan writes no target; convert apply writes target and keeps the bundle", () => {
    // Convert reads the source project and writes the target into the
    // SAME project (one --project serves both sides), so work on a
    // scratch copy of the fixture, never the fixture itself.
    const proj = path.join(dir, "proj");
    fs.cpSync(path.join(FIX, "cursor-project"), proj, { recursive: true });
    const out = path.join(dir, "conv");
    const agentsFile = path.join(proj, "AGENTS.md");
    const before = fs.readFileSync(agentsFile, "utf8");
    const plan = run(
      ["convert", "--from", "cursor", "--to", "codex", "--scope", "project", "--project", proj, "--out", out],
      homesEnv(),
    );
    assert.equal(plan.code, 0);
    // Plan mode must not touch the target (AGENTS.md unchanged, no
    // backup created next to it). The intermediate bundle itself is
    // materialized by convert and reported — that is scratch, not a
    // target write (documented in README).
    assert.equal(fs.readFileSync(agentsFile, "utf8"), before);
    assert.ok(!fs.existsSync(agentsFile + ".memport-bak"));
    assert.ok(fs.existsSync(path.join(out, "memport.json")));
    const applied = run(
      ["convert", "--from", "cursor", "--to", "codex", "--scope", "project", "--project", proj, "--out", out, "--apply"],
      homesEnv(),
    );
    assert.equal(applied.code, 0);
    const after = fs.readFileSync(agentsFile, "utf8");
    assert.ok(after.includes("<!-- BEGIN MEMPORT -->"));
    assert.ok(after.startsWith(before.trimEnd().slice(0, 20)));
    assert.ok(fs.existsSync(agentsFile + ".memport-bak"));
    assert.equal(fs.readFileSync(agentsFile + ".memport-bak", "utf8"), before);
    assert.equal(run(["validate", out]).code, 0);
  });

  it("merge plan writes nothing; strict refuses conflicts; apply writes report", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    const shared = mintItem({ kind: "rule", title: "Shared", scope: "project", origin: "human", source_tool: "hand", body: "A version." });
    const other = { ...shared, body: "B version." };
    writeBundle(a, [shared], { source_tool: "hand", source_path: null, project: null });
    writeBundle(b, [other], { source_tool: "hand", source_path: null, project: null });
    const out = path.join(dir, "m");
    const plan = run(["merge", a, b, "--out", out]);
    assert.equal(plan.code, 0);
    assert.ok(plan.stdout.includes("conflicts: 1"));
    assert.ok(!fs.existsSync(out));
    const strict = run(["merge", a, b, "--out", out, "--apply", "--strict"]);
    assert.notEqual(strict.code, 0);
    assert.ok(!fs.existsSync(out));
    const applied = run(["merge", a, b, "--out", out, "--apply"]);
    assert.equal(applied.code, 0);
    assert.ok(fs.existsSync(path.join(out, "merge-report.md")));
    assert.equal(run(["validate", out]).code, 0);
  });

  it("validate rejects a tampered bundle; list filters and --json work", () => {
    const out = path.join(dir, "b");
    run(["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", out, "--apply"], homesEnv());
    assert.equal(run(["validate", out]).code, 0);
    const items = fs.readdirSync(path.join(out, "items"));
    fs.appendFileSync(path.join(out, "items", items[0]), "\nTampered.\n");
    assert.notEqual(run(["validate", out]).code, 0);
    const list = run(["list", path.join(FIX, "golden-decision"), "--kind", "decision", "--json"]);
    assert.equal(list.code, 0);
    const parsed = JSON.parse(list.stdout) as { kind: string }[];
    assert.equal(parsed.length, 2);
    assert.ok(parsed.every((i) => i.kind === "decision"));
  });

  it("refuses to guess scope; refuses cursor user scope", () => {
    const r1 = run(["bundle", "--from", "cursor", "--out", path.join(dir, "x")], homesEnv());
    assert.notEqual(r1.code, 0);
    assert.ok((r1.stderr + r1.stdout).includes("scope"));
    const r2 = run(["apply", "--bundle", path.join(FIX, "golden-basic"), "--to", "cursor", "--scope", "user"], homesEnv());
    assert.notEqual(r2.code, 0);
  });

  it("secret-flagged items block apply unless --allow-secrets", () => {
    const bundleDir = path.join(dir, "b");
    const flagged = mintItem({
      kind: "note",
      title: "Leaked",
      scope: "project",
      origin: "human",
      source_tool: "hand",
      body: "Do not share: AKIAIOSFODNN7EXAMPLE inside.",
    });
    writeBundle(bundleDir, [flagged], { source_tool: "hand", source_path: null, project: null });
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const blocked = run(["apply", "--bundle", bundleDir, "--to", "claude", "--scope", "project", "--project", proj, "--apply"]);
    assert.notEqual(blocked.code, 0);
    assert.ok(!fs.existsSync(path.join(proj, ".claude", "rules", "memport.md")));
    const allowed = run(["apply", "--bundle", bundleDir, "--to", "claude", "--scope", "project", "--project", proj, "--apply", "--allow-secrets"]);
    assert.equal(allowed.code, 0);
    assert.ok(fs.existsSync(path.join(proj, ".claude", "rules", "memport.md")));
  });
});

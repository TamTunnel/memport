import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBundle, mintItem, sha256Hex } from "../src/format.ts";

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
    // L2: list --json now carries validity alongside the items.
    const parsed = JSON.parse(list.stdout) as { valid: boolean; validationErrors: string[]; items: { kind: string }[] };
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.validationErrors, []);
    assert.equal(parsed.items.length, 2);
    assert.ok(parsed.items.every((i) => i.kind === "decision"));
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

describe("cli end-to-end (fix round)", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function tamperedBundle(): string {
    const bundleDir = path.join(dir, "b");
    const item = mintItem({ kind: "rule", title: "T", scope: "project", origin: "human", source_tool: "hand", body: "Original." });
    writeBundle(bundleDir, [item], { source_tool: "hand", source_path: null, project: null });
    fs.appendFileSync(path.join(bundleDir, "items", `${item.meta.id}.md`), "\nTampered.\n");
    return bundleDir;
  }

  it("apply refuses a tampered bundle at the CLI level (M9)", () => {
    const bundleDir = tamperedBundle();
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const r = run(["apply", "--bundle", bundleDir, "--to", "codex", "--scope", "project", "--project", proj]);
    assert.notEqual(r.code, 0);
    assert.ok((r.stdout + r.stderr).includes("invalid bundle"));
    assert.ok(!fs.existsSync(path.join(proj, "AGENTS.md")));
  });

  it("list warns on an invalid bundle instead of presenting it as legitimate (L2)", () => {
    const bundleDir = tamperedBundle();
    const human = run(["list", bundleDir]);
    assert.equal(human.code, 0);
    assert.ok(human.stdout.includes("WARNING") && human.stdout.includes("FAILED validation"));
    const json = run(["list", bundleDir, "--json"]);
    const parsed = JSON.parse(json.stdout) as { valid: boolean; validationErrors: string[] };
    assert.equal(parsed.valid, false);
    assert.ok(parsed.validationErrors.length > 0);
  });

  it("bundle --out into a forged existing bundle is refused, even in plan mode (H3)", () => {
    const forged = tamperedBundle();
    const r = run(
      ["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", forged],
      homesEnv(),
    );
    assert.notEqual(r.code, 0);
    assert.ok((r.stdout + r.stderr).includes("invalid existing bundle"));
    // No laundering rewrite happened: the bundle still fails validation.
    assert.notEqual(run(["validate", forged]).code, 0);
  });

  it("bundle --out into a bundle with a symlinked item file is refused (F1)", () => {
    const bundleDir = path.join(dir, "b");
    const item = mintItem({ kind: "rule", title: "T", scope: "project", origin: "human", source_tool: "hand", body: "Outside wins if followed." });
    writeBundle(bundleDir, [item], { source_tool: "hand", source_path: null, project: null });
    const outside = path.join(dir, "outside.md");
    fs.writeFileSync(outside, "Outside content.\n");
    fs.unlinkSync(path.join(bundleDir, "items", `${item.meta.id}.md`));
    fs.symlinkSync(outside, path.join(bundleDir, "items", `${item.meta.id}.md`));
    const r = run(
      ["bundle", "--from", "cursor", "--scope", "project", "--project", path.join(FIX, "cursor-project"), "--out", bundleDir],
      homesEnv(),
    );
    assert.notEqual(r.code, 0);
    assert.ok((r.stdout + r.stderr).includes("symlinked"));
  });

  it("merge --apply with secret-bearing losers is gated on --allow-secrets (H5)", () => {
    const fakeKey = "sk-ant-api03-abcdefghijklmnopqrst";
    const loser = mintItem({ kind: "rule", title: "Leaky", scope: "project", origin: "agent-learned", source_tool: "hand", body: `Key: ${fakeKey}` });
    const winner = { ...loser, body: "Clean version." };
    winner.meta = { ...loser.meta, origin: "human" };
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    writeBundle(a, [loser], { source_tool: "hand", source_path: null, project: null });
    writeBundle(b, [winner], { source_tool: "hand", source_path: null, project: null });
    const out = path.join(dir, "m");
    const plan = run(["merge", a, b, "--out", out]);
    assert.equal(plan.code, 0);
    assert.ok(plan.stdout.includes("SECRET FLAGS"));
    assert.ok(!fs.existsSync(out));
    const blocked = run(["merge", a, b, "--out", out, "--apply"]);
    assert.notEqual(blocked.code, 0);
    assert.ok((blocked.stdout + blocked.stderr).includes("secret-flagged"));
    assert.ok(!fs.existsSync(out));
    const allowed = run(["merge", a, b, "--out", out, "--apply", "--allow-secrets"]);
    assert.equal(allowed.code, 0);
    assert.ok(fs.existsSync(path.join(out, "merge-report.md")));
    assert.ok(fs.readFileSync(path.join(out, "merge-report.md"), "utf8").includes("Secret flags"));
  });

  it("re-import preserves the existing item's status (M3)", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Project rules.\n");
    const out = path.join(dir, "b");
    const first = run(["bundle", "--from", "claude", "--scope", "project", "--project", proj, "--out", out, "--apply"], homesEnv());
    assert.equal(first.code, 0);
    const files = fs.readdirSync(path.join(out, "items"));
    assert.equal(files.length, 1);
    const file = path.join(out, "items", files[0]);
    const text = fs.readFileSync(file, "utf8").replace('status: "active"', 'status: "superseded"');
    fs.writeFileSync(file, text);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "memport.json"), "utf8")) as {
      items: { sha256: string }[];
    };
    manifest.items[0].sha256 = sha256Hex(text);
    fs.writeFileSync(path.join(out, "memport.json"), JSON.stringify(manifest, null, 2));
    assert.equal(run(["validate", out]).code, 0);
    const again = run(["bundle", "--from", "claude", "--scope", "project", "--project", proj, "--out", out, "--apply"], homesEnv());
    assert.equal(again.code, 0);
    assert.ok(again.stdout.includes("reused ids: 1"));
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.includes('status: "superseded"'), after);
  });

  it("convert keeps its intermediate temp bundle after plan and apply (M6)", () => {
    const proj = path.join(dir, "proj");
    fs.cpSync(path.join(FIX, "cursor-project"), proj, { recursive: true });
    const plan = run(["convert", "--from", "cursor", "--to", "codex", "--scope", "project", "--project", proj, "--json"], homesEnv());
    assert.equal(plan.code, 0);
    const planBundle = (JSON.parse(plan.stdout) as { bundle: string }).bundle;
    assert.ok(fs.existsSync(path.join(planBundle, "memport.json")), planBundle);
    const applied = run(["convert", "--from", "cursor", "--to", "codex", "--scope", "project", "--project", proj, "--apply", "--json"], homesEnv());
    assert.equal(applied.code, 0);
    const appliedBundle = (JSON.parse(applied.stdout) as { bundle: string }).bundle;
    assert.ok(fs.existsSync(path.join(appliedBundle, "memport.json")), appliedBundle);
  });

  it("scan dedupes the Codex global file across user + project scopes (M4)", () => {
    const r = run(["scan", "--project", path.join(FIX, "codex-project"), "--json"], homesEnv());
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as { tools: { tool: string; total: number }[] };
    const codex = parsed.tools.find((t) => t.tool === "codex");
    assert.ok(codex);
    // User scope: global AGENTS.md + 1 memory note = 2; project scope:
    // global + project AGENTS.md = 2; the global file counted once = 3.
    assert.equal(codex.total, 3);
  });

  it("apply plan lists rendered items and the identity warning (F2/F4)", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const json = run(["apply", "--bundle", path.join(FIX, "golden-basic"), "--to", "codex", "--scope", "project", "--project", proj, "--json"]);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout) as {
      renderedItems: { id: string; title: string }[];
      warnings: string[];
      secretFlags: unknown[];
    };
    assert.deepEqual(
      parsed.renderedItems.map((i) => i.title),
      ["Concise answers", "Run tests before committing"],
    );
    assert.ok(parsed.renderedItems.every((i) => i.id.length === 26));
    assert.ok(parsed.warnings.some((w) => w.includes("Identity loss on re-import")));
    const human = run(["apply", "--bundle", path.join(FIX, "golden-basic"), "--to", "codex", "--scope", "project", "--project", proj]);
    assert.ok(human.stdout.includes("Concise answers"));
    assert.ok(human.stdout.includes("Run tests before committing"));
  });

  it("apply plan warns on a symlinked target and keeps secrets out of --json (H1/L6, M10/H4)", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const victim = path.join(dir, "victim.md");
    fs.writeFileSync(victim, "# Victim\n");
    fs.symlinkSync(victim, path.join(proj, "AGENTS.md"));
    const bundleDir = path.join(dir, "b");
    const leaky = mintItem({ kind: "note", title: "Leaky", scope: "project", origin: "human", source_tool: "hand", body: "Key: sk-ant-api03-abcdefghijklmnopqrst" });
    writeBundle(bundleDir, [leaky], { source_tool: "hand", source_path: null, project: null });
    const json = run(["apply", "--bundle", bundleDir, "--to", "codex", "--scope", "project", "--project", proj, "--json"]);
    assert.equal(json.code, 0);
    assert.ok(json.stdout.includes("is a symlink"));
    assert.ok(!json.stdout.includes("sk-ant-api03"));
    const parsed = JSON.parse(json.stdout) as { secretFlags: { patterns: string[] }[] };
    assert.deepEqual(parsed.secretFlags[0].patterns, ["anthropic-key"]);
    assert.equal(fs.readFileSync(victim, "utf8"), "# Victim\n");
  });

  it("bundle plan warns about symlinked tool-native files (M12)", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Root rules.\n");
    const victim = path.join(dir, "victim.md");
    fs.writeFileSync(victim, "Outside content.\n");
    fs.symlinkSync(victim, path.join(proj, ".claude", "rules", "linked.md"));
    const r = run(["bundle", "--from", "claude", "--scope", "project", "--project", proj, "--out", path.join(dir, "b")], homesEnv());
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("skipped symlinked file") && r.stdout.includes("linked.md"));
  });
});

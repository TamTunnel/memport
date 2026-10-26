import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BEGIN_MARKER,
  END_MARKER,
  escapeMarkerLines,
  executeWrite,
  planDelimitedSection,
  planOwnFile,
  provenanceLine,
  renderDocument,
  scanMarkers,
} from "../src/render.ts";
import { readBundle, writeBundle, mintItem, type MemportItem } from "../src/format.ts";
import { planApply } from "../src/render.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memport-render-"));
}

function sampleItem(title: string, body = "Body text."): MemportItem {
  return mintItem({
    kind: "rule",
    title,
    scope: "project",
    origin: "human",
    source_tool: "hand",
    body,
  });
}

describe("render: own files", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a missing file, then second plan is a noop", () => {
    const target = path.join(dir, "memport.md");
    const p1 = planOwnFile(target, "# Memport rules\n\nhello\n", false);
    assert.equal(p1.action, "create");
    assert.equal(p1.backup, null);
    executeWrite(p1);
    assert.equal(fs.readFileSync(target, "utf8"), "# Memport rules\n\nhello\n");
    const p2 = planOwnFile(target, "# Memport rules\n\nhello\n", false);
    assert.equal(p2.action, "noop");
  });

  it("replaces with exactly one backup; second replace keeps it unless --force", () => {
    const target = path.join(dir, "memport.md");
    fs.writeFileSync(target, "original\n");
    const p1 = planOwnFile(target, "v2\n", false);
    assert.equal(p1.action, "replace");
    assert.equal(p1.backup, target + ".memport-bak");
    executeWrite(p1);
    assert.equal(fs.readFileSync(target + ".memport-bak", "utf8"), "original\n");
    assert.equal(fs.readFileSync(target, "utf8"), "v2\n");
    const p2 = planOwnFile(target, "v3\n", false);
    assert.equal(p2.action, "replace");
    assert.equal(p2.backup, null);
    assert.equal(p2.backupExists, true);
    executeWrite(p2);
    assert.equal(fs.readFileSync(target + ".memport-bak", "utf8"), "original\n");
    const p3 = planOwnFile(target, "v4\n", true);
    assert.equal(p3.backup, target + ".memport-bak");
    executeWrite(p3);
    assert.equal(fs.readFileSync(target + ".memport-bak", "utf8"), "v3\n");
  });
});

describe("render: delimited sections", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends a section preserving surrounding content, then replaces only it", () => {
    const target = path.join(dir, "AGENTS.md");
    fs.writeFileSync(target, "# Team\n\nNotes.\n");
    const p1 = planDelimitedSection(target, "## A\n\nfirst\n", false);
    assert.equal(p1.action, "replace");
    executeWrite(p1);
    let text = fs.readFileSync(target, "utf8");
    assert.ok(text.startsWith("# Team\n\nNotes.\n"));
    assert.ok(text.includes(BEGIN_MARKER) && text.includes("## A"));
    const p2 = planDelimitedSection(target, "## A\n\nsecond\n", false);
    executeWrite(p2);
    text = fs.readFileSync(target, "utf8");
    assert.ok(text.startsWith("# Team\n\nNotes.\n"));
    assert.ok(text.includes("second") && !text.includes("first"));
    assert.equal(text.match(new RegExp(BEGIN_MARKER, "g"))?.length, 1);
    const p3 = planDelimitedSection(target, "## A\n\nsecond\n", false);
    assert.equal(p3.action, "noop");
  });

  it("refuses duplicated markers, wrong order, and markers in code fences", () => {
    assert.ok("refuse" in scanMarkers([BEGIN_MARKER, "x", BEGIN_MARKER, END_MARKER]));
    assert.ok("refuse" in scanMarkers([END_MARKER, "x", BEGIN_MARKER]));
    assert.ok(
      "refuse" in
        scanMarkers(["```md", BEGIN_MARKER, "```", END_MARKER]),
    );
    const target = path.join(dir, "AGENTS.md");
    fs.writeFileSync(target, `${BEGIN_MARKER}\nold\n${BEGIN_MARKER}\n`);
    const p = planDelimitedSection(target, "new\n", false);
    assert.equal(p.action, "refuse");
    assert.ok((p.refuseReason ?? "").includes("duplicated"));
  });

  it("escapes literal marker lines in item bodies and reports them", () => {
    const item = sampleItem("Tricky", `Intro.\n${END_MARKER}\nOutro.`);
    const { text, escapedTitles } = renderDocument([item]);
    assert.deepEqual(escapedTitles, ["Tricky"]);
    assert.ok(!text.split("\n").some((l) => l.trim() === END_MARKER));
    assert.ok(text.includes("escaped, was a section marker line"));
    const direct = escapeMarkerLines(`a\n${BEGIN_MARKER}\nb`);
    assert.equal(direct.escaped, true);
  });

  it("every rendered item carries a visible provenance line", () => {
    const item = sampleItem("Prov");
    const line = provenanceLine(item);
    assert.ok(line.includes(item.meta.id));
    assert.ok(line.includes("hand"));
    assert.ok(!line.startsWith("<!--"));
  });
});

describe("render: planApply (codex budget + own-file targets)", () => {
  it("warns when a codex apply would exceed the 32 KiB chain budget", () => {
    const dir = tmpDir();
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "# Big\n\n" + "y".repeat(40000));
    const bundleDir = path.join(dir, "bundle");
    writeBundle(bundleDir, [sampleItem("Small")], { source_tool: "hand", source_path: null, project: null });
    const plan = planApply(readBundle(bundleDir), { tool: "codex", scope: "project", projectDir: proj });
    assert.ok(plan.warnings.some((w) => w.includes("over the 32768 byte budget")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

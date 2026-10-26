import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mintItem,
  readBundle,
  writeBundle,
  type MemportItem,
} from "../src/format.ts";
import { mergeBundles } from "../src/merge.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memport-merge-"));
}

function item(
  over: Partial<MemportItem["meta"]> = {},
  body = "Body.",
): MemportItem {
  const it = mintItem({
    kind: "rule",
    title: "T",
    scope: "project",
    origin: "human",
    source_tool: "hand",
    body,
  });
  it.meta = { ...it.meta, ...over };
  return it;
}

function bundle(dir: string, items: MemportItem[]) {
  writeBundle(dir, items, { source_tool: "hand", source_path: null, project: null });
  return readBundle(dir);
}

describe("merge", () => {
  let a = "";
  let b = "";
  beforeEach(() => {
    a = tmpDir();
    b = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it("rule 1: same id + identical body dedupes to one item", () => {
    const one = item({ title: "Same" }, "Identical body.");
    const two = { ...one, body: "Identical body.\n" };
    const res = mergeBundles(bundle(a, [one]), bundle(b, [two]));
    assert.equal(res.items.length, 1);
    assert.equal(res.dedupedCount, 1);
    assert.equal(res.conflicts.length, 0);
  });

  it("rule 2: same id + different body — human origin beats agent-learned; loser preserved in report", () => {
    const base = item({ title: "Contested" }, "Agent version.");
    base.meta.origin = "agent-learned";
    const human = { ...base, body: "Human version." };
    human.meta = { ...base.meta, origin: "human" };
    const res = mergeBundles(bundle(a, [base]), bundle(b, [human]));
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].body, "Human version.");
    assert.equal(res.conflicts.length, 1);
    assert.ok(res.report.includes("Agent version."));
    assert.ok(res.report.includes("Superseded versions"));
  });

  it("rule 2: same origin — newer updated wins", () => {
    const old = item({ title: "Race" }, "Old.");
    old.meta.updated = "2026-01-01T00:00:00.000Z";
    const newer = { ...old, body: "New." };
    newer.meta = { ...old.meta, updated: "2026-06-01T00:00:00.000Z" };
    const res = mergeBundles(bundle(a, [old]), bundle(b, [newer]));
    assert.equal(res.items[0].body, "New.");
  });

  it("rule 3: different ids + identical content dedupe to the older id", () => {
    const older = item({ title: "Dup" }, "Same content.");
    older.meta.created = "2026-01-01T00:00:00.000Z";
    const newer = item({ title: "Dup" }, "Same content.");
    newer.meta.created = "2026-06-01T00:00:00.000Z";
    const res = mergeBundles(bundle(a, [older]), bundle(b, [newer]));
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].meta.id, older.meta.id);
    assert.ok(res.report.includes("Deduped sources"));
  });

  it("rule 4: same title + different body keeps both and lists a possible duplicate", () => {
    const one = item({ title: "Maybe same" }, "Version one.");
    const two = item({ title: "maybe  same!" }, "Version two.");
    const res = mergeBundles(bundle(a, [one]), bundle(b, [two]));
    assert.equal(res.items.length, 2);
    assert.equal(res.possibleDuplicates.length, 1);
  });

  it("rule 5: a merge never changes an item's id", () => {
    const one = item({ title: "Keep" }, "A.");
    const two = item({ title: "Keep2" }, "B.");
    const res = mergeBundles(bundle(a, [one]), bundle(b, [two]));
    const ids = new Set(res.items.map((i) => i.meta.id));
    assert.ok(ids.has(one.meta.id) && ids.has(two.meta.id));
  });

  it("refuses to merge a bundle that fails validation", () => {
    const good = bundle(a, [item()]);
    const badDir = b;
    const badItem = item({ title: "Bad" }, "Original.");
    writeBundle(badDir, [badItem], { source_tool: "hand", source_path: null, project: null });
    const loaded = readBundle(badDir);
    fs.appendFileSync(path.join(badDir, "items", `${badItem.meta.id}.md`), "\nTampered.\n");
    assert.throws(() => mergeBundles(good, loaded), /refusing to merge invalid second bundle/);
  });

  it("golden bundles merge cleanly (5 items, no conflicts)", () => {
    const fix = path.join(process.cwd(), "test", "fixtures");
    const res = mergeBundles(readBundle(path.join(fix, "golden-basic")), readBundle(path.join(fix, "golden-decision")));
    assert.equal(res.items.length, 5);
    assert.equal(res.conflicts.length, 0);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mintItem,
  readBundle,
  serializeItem,
  sha256Hex,
  validateBundle,
  writeBundle,
  type MemportItem,
} from "../src/format.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memport-format-"));
}

function sampleItem(over: Partial<MemportItem["meta"]> = {}, body = "Sample body."): MemportItem {
  const item = mintItem({
    kind: "rule",
    title: "Sample",
    scope: "project",
    origin: "human",
    source_tool: "hand",
    body,
  });
  item.meta = { ...item.meta, ...over };
  return item;
}

describe("format: bundle round-trip and validation", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads a bundle with matching hashes", () => {
    const items = [sampleItem({ title: "One" }), sampleItem({ title: "Two" }, "Second body.")];
    writeBundle(dir, items, { source_tool: "hand", source_path: null, project: null });
    const errors = validateBundle(dir);
    assert.deepEqual(errors, []);
    const loaded = readBundle(dir);
    assert.equal(loaded.items.length, 2);
    assert.deepEqual(
      loaded.items.map((i) => i.meta.title).sort(),
      ["One", "Two"],
    );
  });

  it("rejects a forged manifest hash", () => {
    const items = [sampleItem()];
    writeBundle(dir, items, { source_tool: null, source_path: null, project: null });
    const itemFile = path.join(dir, "items", `${items[0].meta.id}.md`);
    fs.appendFileSync(itemFile, "\nTampered!\n");
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("sha256")), JSON.stringify(errors));
  });

  it("rejects a bundle claiming memport/2", () => {
    const items = [sampleItem()];
    const manifest = writeBundle(dir, items, { source_tool: null, source_path: null, project: null });
    manifest.format = "memport/2";
    fs.writeFileSync(path.join(dir, "memport.json"), JSON.stringify(manifest, null, 2));
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("memport/2")), JSON.stringify(errors));
  });

  it("rejects duplicate ids", () => {
    const a = sampleItem({ title: "A" });
    const b = sampleItem({ title: "B" });
    b.meta.id = a.meta.id; // force a duplicate
    // writeBundle sorts by id; write both files manually under one manifest
    writeBundle(dir, [a], { source_tool: null, source_path: null, project: null });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "memport.json"), "utf8")) as {
      items: { id: string; file: string; sha256: string }[];
    };
    const bText = serializeItem(b);
    fs.writeFileSync(path.join(dir, "items", `${b.meta.id}.md`), bText);
    // Manifest with two entries for the same id (second file overwrote first).
    manifest.items.push({ id: b.meta.id, file: `items/${b.meta.id}.md`, sha256: "x" });
    fs.writeFileSync(path.join(dir, "memport.json"), JSON.stringify(manifest, null, 2));
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("duplicate id")), JSON.stringify(errors));
  });

  it("rejects supersedes pointing at a missing id", () => {
    const item = sampleItem({ supersedes: "01M5V702KTKM3Y0KYWA5PP3QS4" });
    writeBundle(dir, [item], { source_tool: null, source_path: null, project: null });
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("supersedes")), JSON.stringify(errors));
  });

  it("rejects a manifest entry escaping the bundle (path traversal)", () => {
    const items = [sampleItem()];
    const manifest = writeBundle(dir, items, { source_tool: null, source_path: null, project: null });
    manifest.items[0].file = "../evil.md";
    fs.writeFileSync(path.join(dir, "memport.json"), JSON.stringify(manifest, null, 2));
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("escapes")), JSON.stringify(errors));
  });

  it("rejects an item missing required fields", () => {
    const items = [sampleItem()];
    writeBundle(dir, items, { source_tool: null, source_path: null, project: null });
    const itemFile = path.join(dir, "items", `${items[0].meta.id}.md`);
    const text = fs.readFileSync(itemFile, "utf8");
    const stripped = text.replace(/title: "[^"]*"\n/, "");
    fs.writeFileSync(itemFile, stripped);
    // Re-hash so the failure is about fields, not the hash.
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "memport.json"), "utf8")) as {
      items: { sha256: string }[];
    };
    manifest.items[0].sha256 = sha256Hex(fs.readFileSync(itemFile));
    fs.writeFileSync(path.join(dir, "memport.json"), JSON.stringify(manifest, null, 2));
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("title")), JSON.stringify(errors));
  });

  it("rejects an item file whose name does not match its id", () => {
    const items = [sampleItem()];
    const manifest = writeBundle(dir, items, { source_tool: null, source_path: null, project: null });
    manifest.items[0].file = "items/renamed.md";
    fs.renameSync(
      path.join(dir, "items", `${items[0].meta.id}.md`),
      path.join(dir, "items", "renamed.md"),
    );
    fs.writeFileSync(path.join(dir, "memport.json"), JSON.stringify(manifest, null, 2));
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("does not match item id")), JSON.stringify(errors));
  });

  it("rejects a bundle with no manifest", () => {
    const errors = validateBundle(dir);
    assert.ok(errors.some((e) => e.includes("memport.json")), JSON.stringify(errors));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, serializeFrontmatter } from "../src/frontmatter.ts";

describe("frontmatter", () => {
  it("parses scalars, lists, and quoted values", () => {
    const text = [
      "---",
      'id: "01M5V702KTKM3Y0KYWA5PP3QS4"',
      "kind: rule",
      "tags:",
      '- "alpha"',
      "- beta",
      "alwaysApply: true",
      "unknown_field: kept",
      "---",
      "Body text.",
      "",
    ].join("\n");
    const { hadFrontmatter, data, body } = parseFrontmatter(text);
    assert.equal(hadFrontmatter, true);
    assert.equal(data["id"], "01M5V702KTKM3Y0KYWA5PP3QS4");
    assert.equal(data["kind"], "rule");
    assert.deepEqual(data["tags"], ["alpha", "beta"]);
    assert.equal(data["alwaysApply"], true);
    assert.equal(data["unknown_field"], "kept"); // unknown fields ignored, not rejected
    assert.equal(body, "Body text.\n");
  });

  it("round-trips serialize/parse without loss", () => {
    const data = {
      id: "01M5V702KTKM3Y0KYWA5PP3QS4",
      kind: "rule",
      title: 'Tricky: title with "quotes" and --- dashes',
      tags: ["a b", "c:d"],
    };
    const body = "Body with --- terminator lines\n---\nand more text.\n";
    const text = serializeFrontmatter(data, body);
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.hadFrontmatter, true);
    assert.equal(parsed.data["title"], 'Tricky: title with "quotes" and --- dashes');
    assert.deepEqual(parsed.data["tags"], ["a b", "c:d"]);
    assert.equal(parsed.body, body);
  });

  it("body containing frontmatter terminators does not break parsing", () => {
    const text = serializeFrontmatter({ id: "01M5V702KTKM3Y0KYWA5PP3QS4" }, "---\n---\n---\n");
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.body, "---\n---\n---\n");
  });

  it("body containing the literal end marker survives parsing", () => {
    const body = "Before\n<!-- END MEMPORT -->\nAfter\n";
    const text = serializeFrontmatter({ id: "01M5V702KTKM3Y0KYWA5PP3QS4" }, body);
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.body, body);
  });

  it("file without frontmatter yields empty data and full body", () => {
    const parsed = parseFrontmatter("# Hello\n\nNo frontmatter here.\n");
    assert.equal(parsed.hadFrontmatter, false);
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.body, "# Hello\n\nNo frontmatter here.\n");
  });

  it("unterminated frontmatter is treated as body (validate rejects later)", () => {
    const parsed = parseFrontmatter("---\nid: abc\nno closing delimiter\n");
    assert.equal(parsed.hadFrontmatter, false);
  });

  it("unparseable frontmatter lines are ignored, not fatal", () => {
    const text = "---\nkind: rule\nthis line has no colon separator at all? no wait it does\n: weird\n---\nBody\n";
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.data["kind"], "rule");
    assert.equal(parsed.body, "Body\n");
  });

  it("omits null/undefined values on serialize", () => {
    const text = serializeFrontmatter({ id: "x", supersedes: null, source_path: undefined }, "B");
    assert.ok(!text.includes("supersedes"));
    assert.ok(!text.includes("source_path"));
  });

  it("parses inline lists and single-quoted values", () => {
    const parsed = parseFrontmatter("---\ntags: [a, 'b c', \"d\"]\ntitle: 'it''s'\n---\nB\n");
    assert.deepEqual(parsed.data["tags"], ["a", "b c", "d"]);
    assert.equal(parsed.data["title"], "it's");
  });
});

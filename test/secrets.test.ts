import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSecrets } from "../src/secrets.ts";

describe("secrets", () => {
  it("flags high-confidence shapes", () => {
    const cases: [string, string][] = [
      ["openai-key", "key is sk-abcdefghijklmnopqrstuvwx and more"],
      ["anthropic-key", "key is sk-ant-api03-abcdefghijklmnopqrstuvwx"],
      ["github-token", "token ghp_abcdefghijklmnopqrstuvwx"],
      ["aws-access-key", "id AKIAIOSFODNN7EXAMPLE here"],
      ["slack-token", "token xoxb-123456789012-abcdefghij"],
      ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----"],
      ["bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwx"],
      ["assigned-api-key", 'api_key = "abcdefghijklmnop1234"'],
    ];
    for (const [pattern, body] of cases) {
      const found = findSecrets(body);
      assert.ok(
        found.some((f) => f.pattern === pattern),
        `${pattern} should be flagged in: ${body}`,
      );
    }
  });

  it("passes clean bodies and bounds excerpts", () => {
    assert.deepEqual(findSecrets("Prefer short replies. Deploy on Fridays is fine."), []);
    const long = "x".repeat(200) + "sk-abcdefghijklmnopqrstuvwx" + "y".repeat(200);
    const found = findSecrets(long);
    assert.equal(found.length, 1);
    assert.ok(found[0].excerpt.length <= 41, found[0].excerpt);
    assert.ok(!found[0].excerpt.includes("y".repeat(50)));
  });
});

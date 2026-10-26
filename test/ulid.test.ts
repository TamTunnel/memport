import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateUlid, isUlid } from "../src/ulid.ts";

describe("ulid", () => {
  it("generates 26-char Crockford base32 ids", () => {
    const id = generateUlid();
    assert.equal(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(isUlid(id), true);
  });

  it("generates unique ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateUlid();
      assert.equal(seen.has(id), false);
      seen.add(id);
    }
  });

  it("rejects non-ULIDs", () => {
    assert.equal(isUlid("not-a-ulid"), false);
    assert.equal(isUlid("01M5V702KTKM3Y0KYWA5PP3QS"), false); // 25 chars
    assert.equal(isUlid("01M5V702KTKM3Y0KYWA5PP3QS4I"), false); // I is not Crockford
    assert.equal(isUlid(123), false);
    assert.equal(isUlid(undefined), false);
  });

  it("is lexicographically sortable by time", () => {
    const a = generateUlid(1000);
    const b = generateUlid(2000);
    assert.ok(a < b);
  });
});

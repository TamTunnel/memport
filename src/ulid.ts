// ULID (Universally Unique Lexicographically Sortable Identifier), per
// https://github.com/ulid/spec — 26 chars, Crockford base32, no deps.
// Layout: 10 chars of 48-bit millisecond timestamp + 16 chars of 80-bit
// randomness. Monotonicity within a millisecond is NOT guaranteed here;
// uniqueness is (80 random bits per id).

import * as crypto from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function isUlid(value: unknown): value is string {
  // ULID spec: 26 Crockford chars; the first char holds only the top 3
  // bits of the 48-bit timestamp, so it must be 0–7. Anything higher
  // overflows the timestamp field and is not a canonical ULID.
  return (
    typeof value === "string" &&
    value.length === 26 &&
    "01234567".includes(value[0]) &&
    [...value].every((c) => CROCKFORD.includes(c))
  );
}

export function generateUlid(nowMs: number = Date.now()): string {
  // 48-bit timestamp, big-endian, encoded as 10 base32 chars.
  let time = Math.floor(nowMs);
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  // 80 random bits as 16 base32 chars.
  const rand = crypto.randomBytes(10);
  const randChars = new Array<string>(16);
  // Encode 80 bits as base32: 80 = 16 * 5, so this is exact.
  let n = 0n;
  for (const b of rand) n = (n << 8n) | BigInt(b);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(n & 31n)];
    n >>= 5n;
  }
  return timeChars.join("") + randChars.join("");
}

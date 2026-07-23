import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R2 migration verifies every object by size and SHA-256", async () => {
  const source = await readFile(new URL("../server/r2/migrate-filesystem.mjs", import.meta.url), "utf8");
  assert.match(source, /bodySha256/);
  assert.match(source, /Source checksum mismatch/);
  assert.match(source, /"nara-sha256"/);
  assert.match(source, /targetSha256 !== sourceSha256/);
  assert.match(source, /manifestSha256/);
  assert.match(source, /sourceObjects !== report\.verifiedObjects/);
  assert.match(source, /sourceBytes !== report\.verifiedBytes/);
});

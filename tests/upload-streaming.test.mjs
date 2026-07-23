import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("media uploads stream the parsed file into storage without an ArrayBuffer copy", () => {
  const route = fs.readFileSync(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8");
  assert.match(route, /bucket\.put\(key, file\.stream\(\)/);
  assert.doesNotMatch(route, /file\.arrayBuffer\(\)/);
});

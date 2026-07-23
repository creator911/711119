import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Valkey outages fail fast and post reads retain a bounded local fallback", async () => {
  const [valkey, views] = await Promise.all([
    readFile(new URL("../server/valkey.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/post-view-counter.ts", import.meta.url), "utf8"),
  ]);
  assert.match(valkey, /disableOfflineQueue:\s*true/);
  assert.match(valkey, /retries >= 3/);
  assert.match(valkey, /unavailableUntil/);
  assert.match(views, /Distributed post view buffer unavailable; using local fallback/);
  assert.match(views, /hashGet\("post-views:pending".*\.catch\(\(\) => null\)/s);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recommendations and reports update their counters in the same transaction", async () => {
  const [recommendation, report, poll] = await Promise.all([
    readFile(new URL("../app/api/posts/[id]/recommend/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/posts/[id]/report/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/posts/[id]/poll/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(recommendation, /await env\.DB\.batch\(\[/);
  assert.match(recommendation, /isUniqueConstraintError\(error\)/);
  assert.match(report, /await env\.DB\.batch\(\[/);
  assert.match(report, /isUniqueConstraintError\(error\)/);
  assert.match(poll, /isUniqueConstraintError\(error\)/);
  for (const source of [recommendation, report, poll]) {
    assert.match(source, /consumeDistributedRateLimit/);
  }
});

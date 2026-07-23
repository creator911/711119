import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("split deployments settle rewards in the worker pool, not public requests", async () => {
  const [route, worker, packageFile] = await Promise.all([
    readFile(new URL("../app/api/events/leaderboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/background-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(route, /APP_SURFACE.*=== "all"/s);
  assert.match(route, /legacy single-process SQLite deployment/);
  assert.match(worker, /settleEventLeaderboard\(env\.DB, period\)/);
  assert.doesNotMatch(worker, /fetch\(.+events\/leaderboard/s);
  assert.match(packageFile, /build-background-worker\.mjs/);
  assert.match(packageFile, /dist\/worker\/background-worker\.mjs/);
});

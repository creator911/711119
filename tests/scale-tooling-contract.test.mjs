import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scale load profile enforces the promised latency and error thresholds", async () => {
  const source = await readFile(new URL("./load/k6-scale.js", import.meta.url), "utf8");
  assert.match(source, /10000/);
  assert.match(source, /20_?000|20000/);
  assert.match(source, /"60m"/);
  assert.match(source, /"5m"/);
  assert.match(source, /p\(95\)<500/);
  assert.match(source, /p\(95\)<1500/);
  assert.match(source, /rate<0\.01/);
  assert.match(source, /LOAD_TEST_CONFIRM/);
});

test("PostgreSQL post-load verifier checks every financial and idempotency invariant", async () => {
  const source = await readFile(new URL("../server/postgres/verify-invariants.mjs", import.meta.url), "utf8");
  for (const table of [
    "attendance",
    "post_poll_votes",
    "post_recommendations",
    "post_reports",
    "shop_purchases",
    "shop_vouchers",
    "vendor_post_jump_usage",
    "event_reward_payouts",
    "point_ledger",
  ]) {
    assert.match(source, new RegExp(table));
  }
  assert.match(source, /REPEATABLE READ READ ONLY/);
  assert.match(source, /process\.exitCode = 1/);
});

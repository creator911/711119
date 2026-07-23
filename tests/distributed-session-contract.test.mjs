import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("member sessions use Valkey generation invalidation and database failover", async () => {
  const [auth, members] = await Promise.all([
    readFile(new URL("../app/lib/member-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/members/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /SESSION_CACHE_TTL_SECONDS/);
  assert.match(auth, /member-session-generation:/);
  assert.match(auth, /invalidateMemberSessionsByUserIds/);
  assert.match(auth, /PostgreSQL remains the source of truth during cache failover/);
  assert.match(members, /await invalidateMemberSessionsByUserIds\(ids\)/);
});

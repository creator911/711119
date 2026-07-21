import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { automaticMemberLevel, MEMBER_LEVEL_REQUIREMENTS } from "../app/lib/member-level.ts";

test("automatic member levels require both post and comment thresholds up to Lv.9", () => {
  assert.deepEqual(MEMBER_LEVEL_REQUIREMENTS.map(({ level }) => level), [9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(automaticMemberLevel(0, 99), 1);
  assert.equal(automaticMemberLevel(1, 2), 1);
  assert.equal(automaticMemberLevel(1, 3), 2);
  assert.equal(automaticMemberLevel(5, 15), 3);
  assert.equal(automaticMemberLevel(20, 50), 4);
  assert.equal(automaticMemberLevel(50, 300), 5);
  assert.equal(automaticMemberLevel(200, 1000), 6);
  assert.equal(automaticMemberLevel(500, 3000), 7);
  assert.equal(automaticMemberLevel(1000, 10000), 8);
  assert.equal(automaticMemberLevel(5000, 50000), 9);
  assert.equal(automaticMemberLevel(100000, 1000000), 9);
});

test("post and comment creation refresh automatic levels while admin changes lock levels", async () => {
  const [postsRoute, commentsRoute, adminMembersRoute, progressLib, schema, migration] = await Promise.all([
    readFile(new URL("../app/api/posts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/posts/[id]/comments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/member-level-progress.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0030_member_level_lock.sql", import.meta.url), "utf8"),
  ]);

  assert.match(postsRoute, /refreshAutomaticMemberLevel\(env\.DB, user\.id\)/);
  assert.match(commentsRoute, /refreshAutomaticMemberLevel\(env\.DB, user\.id\)/);
  assert.match(progressLib, /level_locked AS levelLocked/);
  assert.match(progressLib, /WHERE id=\? AND level_locked=0 AND level<10/);
  assert.match(adminMembersRoute, /level_locked = \?/);
  assert.match(adminMembersRoute, /current\.level !== level \? 1/);
  assert.match(schema, /levelLocked: integer\("level_locked"/);
  assert.match(migration, /ALTER TABLE users ADD COLUMN level_locked integer NOT NULL DEFAULT 0/);
  assert.match(migration, /UPDATE users SET level_locked=1 WHERE level<>1/);
});

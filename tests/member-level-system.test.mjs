import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { attendancePointsForLevel, automaticMemberLevel, MEMBER_LEVEL_REQUIREMENTS } from "../app/lib/member-level.ts";

test("automatic member levels require attendance, post, and comment thresholds up to Lv.5", () => {
  assert.deepEqual(MEMBER_LEVEL_REQUIREMENTS.map(({ level }) => level), [5, 4, 3, 2]);
  assert.equal(automaticMemberLevel(4, 10, 5), 1);
  assert.equal(automaticMemberLevel(5, 9, 5), 1);
  assert.equal(automaticMemberLevel(5, 10, 4), 1);
  assert.equal(automaticMemberLevel(5, 10, 5), 2);
  assert.equal(automaticMemberLevel(20, 50, 30), 3);
  assert.equal(automaticMemberLevel(50, 100, 100), 4);
  assert.equal(automaticMemberLevel(100, 300, 150), 5);
  assert.equal(automaticMemberLevel(5000, 50000, 5000), 5);
});

test("attendance points increase by member level", () => {
  assert.equal(attendancePointsForLevel(1), 50);
  assert.equal(attendancePointsForLevel(2), 60);
  assert.equal(attendancePointsForLevel(3), 70);
  assert.equal(attendancePointsForLevel(5), 90);
  assert.equal(attendancePointsForLevel(9), 130);
  assert.equal(attendancePointsForLevel(10), 140);
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
  assert.match(progressLib, /attendanceCount/);
  assert.match(progressLib, /WHERE id=\? AND level_locked=0 AND level<10/);
  assert.match(adminMembersRoute, /level_locked = \?/);
  assert.match(adminMembersRoute, /current\.level !== level \? 1/);
  assert.match(schema, /levelLocked: integer\("level_locked"/);
  assert.match(migration, /ALTER TABLE users ADD COLUMN level_locked integer NOT NULL DEFAULT 0/);
  assert.match(migration, /UPDATE users SET level_locked=1 WHERE level<>1/);
});

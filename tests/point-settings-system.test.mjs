import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("point system defaults match requested rewards and level thresholds", async () => {
  const source = await readFile(new URL("../app/lib/point-settings.ts", import.meta.url), "utf8");
  assert.match(source, /postCreatePoints:\s*10/);
  assert.match(source, /reviewCreatePoints:\s*50/);
  assert.match(source, /commentCreatePoints:\s*5/);
  assert.match(source, /attendanceBasePoints:\s*50/);
  assert.match(source, /attendanceLevelStepPoints:\s*10/);
  assert.match(source, /weekly:\s*\{\s*posts:\s*\[10000,\s*5000,\s*1000\],\s*comments:\s*\[10000,\s*5000,\s*1000\]/);
  assert.match(source, /monthly:\s*\{\s*posts:\s*\[10000,\s*5000,\s*1000\],\s*comments:\s*\[10000,\s*5000,\s*1000\]/);
  assert.match(source, /normalizePointSettings/);
  assert.match(source, /automaticMemberLevelForSettings/);
});

test("post, comment, attendance, leaderboard, and admin UI use shared point settings", async () => {
  const [postsRoute, commentsRoute, contentRewards, attendanceRoute, leaderboard, admin, adminPoint, route] = await Promise.all([
    readFile(new URL("../app/api/posts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/posts/[id]/comments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/content-rewards.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attendance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/event-leaderboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminPointSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/point-settings/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(postsRoute, /loadPointSettings\(env\.DB\)/);
  assert.match(postsRoute, /reviewCreatePoints/);
  assert.match(postsRoute, /postCreatePoints/);
  assert.match(postsRoute, /publishPostWithReward\(env\.DB/);
  assert.match(commentsRoute, /commentCreatePoints/);
  assert.match(commentsRoute, /publishCommentWithReward\(env\.DB/);
  assert.match(contentRewards, /point_ledger\(user_id,amount,type,status,reference,created_at\)/);
  assert.match(attendanceRoute, /attendancePointsForSettings/);
  assert.match(leaderboard, /pointSettings\.eventRewards/);
  assert.match(admin, /<AdminPointSettings \/>/);
  assert.match(adminPoint, /자동 레벨업 조건/);
  assert.match(adminPoint, /주간 랭킹/);
  assert.match(route, /savePointSettings\(env\.DB, payload, operator\.username\)/);
});

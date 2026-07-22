import assert from "node:assert/strict";
import { openD1Database } from "../server/d1-sqlite.mjs";

const baseUrl = process.env.TEST_BASE_URL;
const databasePath = process.env.TEST_DB_PATH;
if (!baseUrl || !databasePath) throw new Error("TEST_BASE_URL and TEST_DB_PATH are required.");
const cookie = "cn_session=level-progress-session";

const anonymous = await fetch(`${baseUrl}/api/member-level-progress`);
assert.equal(anonymous.status, 401);

const initial = await fetch(`${baseUrl}/api/member-level-progress`, { headers: { Cookie: cookie } });
assert.equal(initial.status, 200);
const initialData = await initial.json();
assert.equal(initialData.level, 1);
assert.deepEqual(initialData.current, { attendance: 0, posts: 0, comments: 50 });
assert.deepEqual(initialData.target, { level: 2, attendance: 6, posts: 7, comments: 12 });
assert.deepEqual(initialData.remaining, { attendance: 6, posts: 7, comments: 0 });
assert.equal(initialData.progressPercent, 33.3);
assert.equal(initialData.attendancePoints, 55);
assert.equal(initialData.nextAttendancePoints, 70);

const database = openD1Database(databasePath);
try {
  const user = await database.prepare("SELECT id FROM users WHERE username='progress-member'").first();
  const postStatements = Array.from({ length: 7 }, (_, index) => database.prepare(`
    INSERT INTO posts(category,title,author_id,status,created_at) VALUES('community',?,?, 'published',?)
  `).bind(`level post ${index + 1}`, user.id, new Date(Date.now() + index).toISOString()));
  const attendanceStatements = Array.from({ length: 6 }, (_, index) => database.prepare(`
    INSERT INTO attendance(user_id,attendance_date,points_awarded,greeting,created_at) VALUES(?,?,55,'test',?)
  `).bind(user.id, `2026-06-${String(index + 1).padStart(2, "0")}`, new Date(Date.now() + index).toISOString()));
  await database.batch([...postStatements, ...attendanceStatements]);
} finally {
  database.close();
}

const promoted = await fetch(`${baseUrl}/api/member-level-progress`, { headers: { Cookie: cookie } });
assert.equal(promoted.status, 200);
const promotedData = await promoted.json();
assert.equal(promotedData.level, 2);
assert.equal(promotedData.current.attendance, 6);
assert.equal(promotedData.current.posts, 7);
assert.equal(promotedData.current.comments, 50);
assert.equal(promotedData.target.level, 3);

console.log("레벨 안내 검증 통과: 회원 전용 조회, 관리자 설정 반영, 33.3% 상한, 자동 레벨업");

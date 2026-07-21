import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { openD1Database } from "../server/d1-sqlite.mjs";

const baseUrl = process.env.TEST_BASE_URL;
const databasePath = process.env.TEST_DB_PATH;
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!baseUrl || !databasePath || !adminUsername || !adminPassword) throw new Error("TEST_BASE_URL, TEST_DB_PATH, TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");

const suffix = Date.now().toString(36);
const password = "RewardAudit!2026";
const users = [1, 2, 3].map((rank) => ({ username: `audit${rank}_${suffix}`.slice(0, 20), nickname: `감사${rank}${suffix.slice(-3)}`.slice(0, 12), level: rank + 1 }));
const userIds = [];
const postIds = [];

const cookieOf = (response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const json = async (response) => ({ response, body: await response.json() });

function withDb(action) {
  const database = openD1Database(databasePath);
  try { return action(database); } finally { database.close(); }
}

function seedUsers() {
  withDb((database) => {
    for (const user of users) {
      const salt = randomBytes(16);
      const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
      database._runSync(`INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,role,status,created_at) VALUES(?,?,?,?,?,0,?,1,'member','active',?)`, [user.username, user.nickname, hash, salt.toString("hex"), "192.0.2.88", user.level, new Date().toISOString()]);
      userIds.push(Number(database._allSync("SELECT id FROM users WHERE username=?", [user.username])[0].id));
    }
  });
}

function cleanup() {
  withDb((database) => {
    for (const id of userIds) {
      database._runSync("DELETE FROM event_reward_payouts WHERE user_id=?", [id]);
      database._runSync("DELETE FROM post_comments WHERE user_id=?", [id]);
      database._runSync("DELETE FROM posts WHERE author_id=?", [id]);
      database._runSync("DELETE FROM sessions WHERE user_id=?", [id]);
      database._runSync("DELETE FROM users WHERE id=?", [id]);
    }
  });
}

try {
  seedUsers();
  assert.equal((await fetch(`${baseUrl}/api/admin/event-rewards`)).status, 401);

  const login = await json(await fetch(`${baseUrl}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: adminUsername, password: adminPassword }) }));
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const cookie = cookieOf(login.response);

  const initial = await json(await fetch(`${baseUrl}/api/admin/event-rewards?period=weekly`, { headers: { Cookie: cookie } }));
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.previous.rows.length, 6);
  assert.equal(initial.body.current.rows.length, 6);

  const createdAt = new Date().toISOString();
  withDb((database) => {
    for (let index = 0; index < userIds.length; index += 1) {
      const userId = userIds[index];
      const activityCount = 3 - index;
      for (let count = 0; count < activityCount; count += 1) {
        database._runSync("INSERT INTO posts(category,title,body,author_id,author_name,status,created_at) VALUES('community',?,?,?,?, 'published',?)", [`감사 글 ${index}-${count}`, "본문", userId, users[index].nickname, createdAt]);
        const postId = Number(database._allSync("SELECT last_insert_rowid() AS id")[0].id);
        postIds.push(postId);
        database._runSync("INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'published',?)", [postId, userId, `댓글 ${index}-${count}`, createdAt]);
      }
      for (const boardType of ["posts", "comments"]) {
        database._runSync(`INSERT INTO event_reward_payouts(period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at) VALUES('weekly',?,?,?,?,?,?,?,?,?,?)`, [boardType, initial.body.previous.period.startAt, initial.body.previous.period.endAt, userId, index + 1, activityCount, [10000, 5000, 1000][index], users[index].nickname, users[index].level, createdAt]);
      }
    }
  });

  const audit = await json(await fetch(`${baseUrl}/api/admin/event-rewards?period=weekly`, { headers: { Cookie: cookie } }));
  assert.equal(audit.response.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.previous.rows.length, 6);
  assert.equal(audit.body.current.rows.length, 6);
  assert.ok(audit.body.previous.rows.every((row) => row.userId && row.nickname && row.level && row.points));
  assert.deepEqual(audit.body.current.rows.slice(0, 3).map((row) => row.nickname), users.map((user) => user.nickname));
  assert.deepEqual(audit.body.current.rows.slice(0, 3).map((row) => row.points), [10000, 5000, 1000]);
  assert.deepEqual(audit.body.current.rows.slice(3, 6).map((row) => row.nickname), users.map((user) => user.nickname));
  console.log("이벤트 보상 로그 통합 검증 통과: 관리자 권한, 지난 지급 6칸, 현재 예상 6칸, 레벨·닉네임·순위·보상금액");
} finally {
  cleanup();
}

import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { openD1Database } from "../server/d1-sqlite.mjs";

const baseUrl = process.env.TEST_BASE_URL;
const databasePath = process.env.TEST_DB_PATH;
if (!baseUrl || !databasePath) throw new Error("TEST_BASE_URL and TEST_DB_PATH are required.");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const suffix = Date.now().toString(36);
const password = "RewardSettlement!2026";
const users = [1, 2, 3].map((rank) => ({
  username: `settle${rank}_${suffix}`.slice(0, 20),
  nickname: `정산${rank}${suffix.slice(-3)}`.slice(0, 12),
  level: rank + 1,
}));
const userIds = [];

function previousWeeklyRange(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const todayKstMidnightUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - KST_OFFSET_MS;
  const daysAfterMonday = (shifted.getUTCDay() + 6) % 7;
  const currentStart = todayKstMidnightUtc - daysAfterMonday * DAY_MS;
  const start = currentStart - 7 * DAY_MS;
  return { startAt: new Date(start).toISOString(), endAt: new Date(currentStart).toISOString() };
}

function withDb(action) {
  const database = openD1Database(databasePath);
  try { return action(database); } finally { database.close(); }
}

function seedActivity(range) {
  withDb((database) => {
    const previousCreatedAt = new Date(Date.parse(range.startAt) + DAY_MS).toISOString();
    const currentCreatedAt = new Date().toISOString();
    for (const [index, user] of users.entries()) {
      const salt = randomBytes(16);
      const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
      database._runSync(
        "INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,role,status,created_at) VALUES(?,?,?,?,?,0,?,1,'member','active',?)",
        [user.username, user.nickname, hash, salt.toString("hex"), "192.0.2.92", user.level, currentCreatedAt],
      );
      const userId = Number(database._allSync("SELECT id FROM users WHERE username=?", [user.username])[0].id);
      userIds.push(userId);
      const activityCount = 3 - index;
      for (const createdAt of [previousCreatedAt, currentCreatedAt]) {
        for (let count = 0; count < activityCount; count += 1) {
          database._runSync(
            "INSERT INTO posts(category,title,body,author_id,author_name,status,created_at) VALUES('community',?,?,?,?, 'published',?)",
            [`정산 글 ${index}-${count}`, "본문", userId, user.nickname, createdAt],
          );
          const postId = Number(database._allSync("SELECT last_insert_rowid() AS id")[0].id);
          database._runSync(
            "INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'published',?)",
            [postId, userId, `댓글 ${index}-${count}`, createdAt],
          );
        }
      }
    }

    // Reproduces the old interrupted state: the payout row exists but neither
    // the member balance nor its ledger entry was committed.
    database._runSync(`
      INSERT INTO event_reward_payouts(
        period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at
      ) VALUES('weekly','posts',?,?,?,?,?,?,?,?,?)
    `, [range.startAt, range.endAt, userIds[0], 1, 3, 10000, users[0].nickname, users[0].level, new Date().toISOString()]);
  });
}

function cleanup(range) {
  withDb((database) => {
    for (const userId of userIds) {
      database._runSync("DELETE FROM point_ledger WHERE user_id=?", [userId]);
      database._runSync("DELETE FROM event_reward_payouts WHERE user_id=?", [userId]);
      database._runSync("DELETE FROM post_comments WHERE user_id=?", [userId]);
      database._runSync("DELETE FROM posts WHERE author_id=?", [userId]);
      database._runSync("DELETE FROM users WHERE id=?", [userId]);
    }
    database._runSync("DELETE FROM site_settings WHERE key LIKE ?", [`event_reward_settled:weekly:%:${range.startAt}`]);
    database._runSync("DELETE FROM site_settings WHERE key LIKE ?", [`event_leaderboard_%:weekly:%:${range.endAt}`]);
  });
}

const range = previousWeeklyRange();
try {
  seedActivity(range);

  withDb((database) => database._execSync(`
    CREATE TRIGGER event_reward_ledger_failure
    BEFORE INSERT ON point_ledger
    WHEN NEW.type='event_reward'
    BEGIN
      SELECT RAISE(ABORT,'forced_event_reward_ledger_failure');
    END
  `));
  const failed = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(failed.status, 500);
  withDb((database) => {
    assert.equal(database._allSync("SELECT COALESCE(SUM(points),0) AS points FROM users WHERE id IN (?,?,?)", userIds)[0].points, 0);
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM point_ledger WHERE type='event_reward' AND user_id IN (?,?,?)", userIds)[0].count, 0);
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_reward_payouts WHERE period_type='weekly' AND period_start=?", [range.startAt])[0].count, 1);
    const marker = database._allSync("SELECT value FROM site_settings WHERE key=?", [`event_reward_settled:weekly:posts:${range.startAt}`])[0];
    assert.match(marker.value, /^pending:/);
    database._execSync("DROP TRIGGER event_reward_ledger_failure");
    database._runSync("UPDATE site_settings SET updated_at='2000-01-01T00:00:00.000Z' WHERE key=?", [`event_reward_settled:weekly:posts:${range.startAt}`]);
  });

  const responses = await Promise.all(Array.from({ length: 12 }, () =>
    fetch(`${baseUrl}/api/events/leaderboard?period=weekly`)));
  assert.ok(responses.every((response) => response.status === 200));

  withDb((database) => {
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_reward_payouts WHERE period_type='weekly' AND period_start=?", [range.startAt])[0].count, 6);
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM point_ledger WHERE type='event_reward' AND user_id IN (?,?,?)", userIds)[0].count, 6);
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE ?", [`event_reward_settled:weekly:%:${range.startAt}`])[0].count, 2);
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE ?", [`event_leaderboard_snapshot:weekly:%:${range.endAt}`])[0].count, 2);
    for (const [index, userId] of userIds.entries()) {
      const expected = [10000, 5000, 1000][index] * 2;
      assert.equal(database._allSync("SELECT points FROM users WHERE id=?", [userId])[0].points, expected);
      assert.equal(database._allSync("SELECT COUNT(*) AS count FROM point_ledger WHERE type='event_reward' AND user_id=?", [userId])[0].count, 2);
    }
  });

  const fastPathBefore = withDb((database) => database._allSync(`
    SELECT key,value,updated_at AS updatedAt FROM site_settings
    WHERE key LIKE ? OR key LIKE ? ORDER BY key
  `, [`event_reward_settled:weekly:%:${range.startAt}`, `event_leaderboard_%:weekly:%:${range.endAt}`]));
  const retry = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(retry.status, 200);
  withDb((database) => {
    for (const [index, userId] of userIds.entries()) {
      assert.equal(database._allSync("SELECT points FROM users WHERE id=?", [userId])[0].points, [10000, 5000, 1000][index] * 2);
    }
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM point_ledger WHERE type='event_reward' AND user_id IN (?,?,?)", userIds)[0].count, 6);
    assert.deepEqual(database._allSync(`
      SELECT key,value,updated_at AS updatedAt FROM site_settings
      WHERE key LIKE ? OR key LIKE ? ORDER BY key
    `, [`event_reward_settled:weekly:%:${range.startAt}`, `event_leaderboard_%:weekly:%:${range.endAt}`]), fastPathBefore);
  });

  const postsSnapshotKey = `event_leaderboard_snapshot:weekly:posts:${range.endAt}`;
  const postsRefreshKey = `event_leaderboard_refresh:weekly:posts:${range.endAt}`;
  const externalClaim = "pending:external-isolate";
  withDb((database) => {
    database._runSync("DELETE FROM site_settings WHERE key=?", [postsSnapshotKey]);
    database._runSync(`
      INSERT INTO site_settings(key,value,updated_by,updated_at) VALUES(?,?,'test',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    `, [postsRefreshKey, externalClaim, new Date().toISOString()]);
  });
  const coldLeaseResponse = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(coldLeaseResponse.status, 200);
  const coldLeaseBody = await coldLeaseResponse.json();
  assert.deepEqual(coldLeaseBody.posts, []);
  withDb((database) => {
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key=?", [postsSnapshotKey])[0].count, 0);
    assert.equal(database._allSync("SELECT value FROM site_settings WHERE key=?", [postsRefreshKey])[0].value, externalClaim);
    database._runSync("UPDATE site_settings SET updated_at='2000-01-01T00:00:00.000Z' WHERE key=?", [postsRefreshKey]);
  });

  const recoveredResponse = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(recoveredResponse.status, 200);
  const recoveredBody = await recoveredResponse.json();
  assert.equal(recoveredBody.posts.length, 3);
  withDb((database) => {
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key=?", [postsSnapshotKey])[0].count, 1);
    assert.match(database._allSync("SELECT value FROM site_settings WHERE key=?", [postsRefreshKey])[0].value, /^complete:/);
    database._runSync("UPDATE site_settings SET value=?,updated_at=? WHERE key=?", [
      JSON.stringify({ generatedAt: "2000-01-01T00:00:00.000Z", rows: [{ userId: userIds[2], nickname: "stale-snapshot", level: users[2].level, count: 777 }] }),
      new Date().toISOString(),
      postsSnapshotKey,
    ]);
    database._runSync("UPDATE site_settings SET value=?,updated_at=? WHERE key=?", [externalClaim, new Date().toISOString(), postsRefreshKey]);
  });
  const staleResponse = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(staleResponse.status, 200);
  const staleBody = await staleResponse.json();
  assert.equal(staleBody.posts[0]?.nickname, "stale-snapshot");

  const catchUpStarts = Array.from({ length: 6 }, (_, index) =>
    new Date(Date.parse(range.startAt) - (index + 1) * 7 * DAY_MS).toISOString());
  const preWatermarkStart = new Date(Date.parse(catchUpStarts.at(-1)) - 7 * DAY_MS).toISOString();
  let stalePayoutUserId = 0;
  withDb((database) => {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
    database._runSync(
      "INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,role,status,created_at) VALUES(?,?,?,?,?,0,1,1,'member','active',?)",
      [`legacy_${suffix}`.slice(0, 20), `legacy${suffix.slice(-4)}`.slice(0, 12), hash, salt.toString("hex"), "192.0.2.93", new Date().toISOString()],
    );
    stalePayoutUserId = Number(database._allSync("SELECT last_insert_rowid() AS id")[0].id);
    userIds.push(stalePayoutUserId);
    database._runSync(`
      INSERT INTO event_reward_payouts(
        period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at
      ) VALUES('weekly','posts',?,?,?,1,99,10000,?,1,?)
    `, [catchUpStarts[0], new Date(Date.parse(catchUpStarts[0]) + 7 * DAY_MS).toISOString(), stalePayoutUserId, `legacy${suffix.slice(-4)}`.slice(0, 12), new Date().toISOString()]);
    database._runSync(
      "UPDATE site_settings SET value=?,updated_at=? WHERE key='event_reward_catchup_watermark:weekly'",
      [catchUpStarts.at(-1), new Date().toISOString()],
    );
    for (const [index, periodStart] of catchUpStarts.entries()) {
      const createdAt = new Date(Date.parse(periodStart) + DAY_MS).toISOString();
      database._runSync(
        "INSERT INTO posts(category,title,body,author_id,author_name,status,created_at) VALUES('community',?,?,?,?, 'published',?)",
        [`catch-up-${index}`, "body", userIds[0], users[0].nickname, createdAt],
      );
      const postId = Number(database._allSync("SELECT last_insert_rowid() AS id")[0].id);
      database._runSync(
        "INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'published',?)",
        [postId, userIds[0], `catch-up-comment-${index}`, createdAt],
      );
    }
    const preWatermarkCreatedAt = new Date(Date.parse(preWatermarkStart) + DAY_MS).toISOString();
    database._runSync(
      "INSERT INTO posts(category,title,body,author_id,author_name,status,created_at) VALUES('community','before-watermark','body',?,?,'published',?)",
      [userIds[0], users[0].nickname, preWatermarkCreatedAt],
    );
    const oldPostId = Number(database._allSync("SELECT last_insert_rowid() AS id")[0].id);
    database._runSync(
      "INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,'before-watermark','published',?)",
      [oldPostId, userIds[0], preWatermarkCreatedAt],
    );
  });

  const firstCatchUp = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(firstCatchUp.status, 200);
  withDb((database) => {
    const completed = catchUpStarts.filter((periodStart) =>
      database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE ? AND value LIKE 'complete:%'", [`event_reward_settled:weekly:%:${periodStart}`])[0].count === 2);
    assert.equal(completed.length, 3, "one request must repair only the configured bounded number of older periods");
    assert.equal(database._allSync("SELECT points FROM users WHERE id=?", [stalePayoutUserId])[0].points, 10000, "existing payout snapshot user is repaired even after live rank changes");
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM point_ledger WHERE user_id=? AND type='event_reward'", [stalePayoutUserId])[0].count, 1);
    const immutableRankOne = database._allSync(`
      SELECT user_id AS userId,COUNT(*) AS count FROM event_reward_payouts
      WHERE period_type='weekly' AND board_type='posts' AND period_start=? AND rank=1
      GROUP BY user_id
    `, [catchUpStarts[0]]);
    assert.deepEqual(immutableRankOne, [{ userId: stalePayoutUserId, count: 1 }], "a changed live ranking cannot replace or duplicate the first rank snapshot");
  });

  const secondCatchUp = await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`);
  assert.equal(secondCatchUp.status, 200);
  withDb((database) => {
    for (const periodStart of catchUpStarts) {
      assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE ? AND value LIKE 'complete:%'", [`event_reward_settled:weekly:%:${periodStart}`])[0].count, 2);
    }
    assert.equal(database._allSync("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE ?", [`event_reward_settled:weekly:%:${preWatermarkStart}`])[0].count, 0, "pre-deployment activity before the watermark must never be paid by catch-up");
  });

  console.log("이벤트 보상 원자성·중복 방지 통합 검증 통과");
} finally {
  cleanup(range);
}

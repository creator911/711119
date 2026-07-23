import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function migratedDatabase() {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const database = new DatabaseSync(":memory:");
  for (const entry of journal.entries) {
    const source = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    for (const statement of source.split(/-->\s*statement-breakpoint/).map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
  return database;
}

const counts = (database) => database.prepare(`
  SELECT period_type AS periodType,period_start AS periodStart,board_type AS boardType,
    user_id AS userId,activity_count AS activityCount
  FROM event_activity_rollups ORDER BY period_type,period_start,board_type,user_id
`).all().map((row) => ({ ...row }));

test("event activity triggers atomically track qualifying post/comment/attendance CRUD", async () => {
  const database = await migratedDatabase();
  try {
    const userInsert = database.prepare(`
      INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,status,created_at)
      VALUES(?,?,?,?,?,'active',?)
    `);
    userInsert.run("rollup-user-1", "rollup-nick-1", "hash", "salt", "192.0.2.1", "2026-07-01T00:00:00.000Z");
    userInsert.run("rollup-user-2", "rollup-nick-2", "hash", "salt", "192.0.2.2", "2026-07-01T00:00:00.000Z");

    const createdAt = "2026-07-22T01:23:45.000Z";
    database.prepare("INSERT INTO posts(category,title,body,author_id,status,created_at) VALUES('community','p','b',1,'published',?)").run(createdAt);
    assert.deepEqual(counts(database).filter((row) => row.boardType === "posts").map(({ periodType, userId, activityCount }) => ({ periodType, userId, activityCount })), [
      { periodType: "monthly", userId: 1, activityCount: 1 },
      { periodType: "weekly", userId: 1, activityCount: 1 },
    ]);

    database.exec("UPDATE posts SET views=views+1 WHERE id=1");
    assert.equal(counts(database).filter((row) => row.boardType === "posts").length, 2, "unrelated updates must not touch rollups");
    database.exec("UPDATE posts SET author_id=2 WHERE id=1");
    assert.ok(counts(database).filter((row) => row.boardType === "posts").every((row) => row.userId === 2));
    database.exec("UPDATE posts SET status='deleted' WHERE id=1");
    assert.equal(counts(database).filter((row) => row.boardType === "posts").length, 0);
    database.exec("UPDATE posts SET status='published',category='events' WHERE id=1");
    assert.equal(counts(database).filter((row) => row.boardType === "posts").length, 0);
    database.exec("UPDATE posts SET category='reviews' WHERE id=1");
    assert.equal(counts(database).filter((row) => row.boardType === "posts").length, 2);
    database.exec("DELETE FROM posts WHERE id=1");
    assert.equal(counts(database).filter((row) => row.boardType === "posts").length, 0);

    database.prepare("INSERT INTO posts(id,category,title,body,author_id,status,created_at) VALUES(1,'events','reply-parent','b',1,'published',?)").run(createdAt);
    database.prepare("INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(1,1,'c','published',?)").run(createdAt);
    database.prepare("INSERT INTO attendance(user_id,attendance_date,created_at) VALUES(1,'2026-07-22',?)").run(createdAt);
    assert.ok(counts(database).filter((row) => row.boardType === "comments").every((row) => row.activityCount === 2));
    database.exec("UPDATE post_comments SET status='deleted' WHERE id=1");
    assert.ok(counts(database).filter((row) => row.boardType === "comments").every((row) => row.activityCount === 1));
    database.exec("UPDATE post_comments SET status='published',user_id=2 WHERE id=1");
    assert.deepEqual(counts(database).filter((row) => row.boardType === "comments").map(({ periodType, userId, activityCount }) => ({ periodType, userId, activityCount })), [
      { periodType: "monthly", userId: 1, activityCount: 1 },
      { periodType: "monthly", userId: 2, activityCount: 1 },
      { periodType: "weekly", userId: 1, activityCount: 1 },
      { periodType: "weekly", userId: 2, activityCount: 1 },
    ]);
    database.exec("UPDATE attendance SET attendance_date='2026-08-03' WHERE id=1");
    assert.equal(counts(database).filter((row) => row.userId === 1).length, 2);
    assert.deepEqual(counts(database).filter((row) => row.userId === 1).map((row) => row.periodStart), [
      "2026-07-31T15:00:00.000Z",
      "2026-08-02T15:00:00.000Z",
    ]);
    database.exec("DELETE FROM post_comments WHERE id=1; DELETE FROM attendance WHERE id=1");
    assert.deepEqual(counts(database), []);
  } finally {
    database.close();
  }
});

test("100k-member leaderboard query uses ranking index without raw activity scans", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY,nickname TEXT NOT NULL,level INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE event_activity_rollups(period_type TEXT NOT NULL,period_start TEXT NOT NULL,board_type TEXT NOT NULL,user_id INTEGER NOT NULL,activity_count INTEGER NOT NULL);
      CREATE UNIQUE INDEX event_activity_rollups_period_user_unique ON event_activity_rollups(period_type,period_start,board_type,user_id);
      CREATE INDEX event_activity_rollups_ranking_idx ON event_activity_rollups(period_type,board_type,period_start,activity_count DESC,user_id);
      WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<100000)
      INSERT INTO users SELECT value,'member-' || value,1,'active' FROM seq;
      WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<100000)
      INSERT INTO event_activity_rollups SELECT 'weekly','2026-07-19T15:00:00.000Z','posts',value,value%1000 FROM seq;
    `);
    const query = `
      SELECT u.id,u.nickname,r.activity_count
      FROM event_activity_rollups r JOIN users u ON u.id=r.user_id
      WHERE r.period_type=? AND r.board_type=? AND r.period_start=? AND r.activity_count>0
        AND u.status='active' AND u.level BETWEEN 1 AND 9
      ORDER BY r.activity_count DESC,r.user_id ASC LIMIT 10
    `;
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all("weekly", "posts", "2026-07-19T15:00:00.000Z").map(({ detail }) => String(detail));
    assert.ok(plan.some((detail) => detail.includes("event_activity_rollups_ranking_idx")), plan.join("\n"));
    assert.ok(!plan.some((detail) => detail.includes("TEMP B-TREE")), plan.join("\n"));
    assert.ok(!plan.some((detail) => detail.includes("SCAN posts") || detail.includes("SCAN post_comments") || detail.includes("SCAN attendance")));
    const writePlan = database.prepare(`
      EXPLAIN QUERY PLAN UPDATE event_activity_rollups SET activity_count=activity_count-1
      WHERE board_type='posts' AND user_id=? AND (
        (period_type='weekly' AND period_start=?) OR (period_type='monthly' AND period_start=?)
      )
    `).all(99999, "2026-07-19T15:00:00.000Z", "2026-06-30T15:00:00.000Z").map(({ detail }) => String(detail));
    assert.ok(writePlan.some((detail) => detail.includes("event_activity_rollups_period_user_unique")), writePlan.join("\n"));
    assert.ok(!writePlan.some((detail) => /^SCAN event_activity_rollups/.test(detail)), writePlan.join("\n"));
    const startedAt = performance.now();
    const rows = database.prepare(query).all("weekly", "posts", "2026-07-19T15:00:00.000Z");
    const elapsedMs = performance.now() - startedAt;
    assert.equal(rows.length, 10);
    assert.equal(rows[0].activity_count, 999);
    console.log(`100k event leaderboard indexed query: ${elapsedMs.toFixed(2)}ms`);
  } finally {
    database.close();
  }
});

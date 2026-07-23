import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const details = (database, sql, ...bindings) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => String(row.detail));

test("high-volume member history, comment counts, and attendance paging use covering indexes", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE point_ledger(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,amount INTEGER NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,reference TEXT,created_at TEXT NOT NULL);
    CREATE INDEX point_ledger_user_id_idx ON point_ledger(user_id,id);
    CREATE TABLE post_comments(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL,user_id INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX post_comments_post_status_id_idx ON post_comments(post_id,status,id);
    CREATE TABLE attendance(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,attendance_date TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX attendance_date_created_id_idx ON attendance(attendance_date,created_at,id);
  `);

  const pointPlan = details(database, "SELECT id,amount FROM point_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100", 7);
  assert.ok(pointPlan.some((detail) => detail.includes("point_ledger_user_id_idx")), pointPlan.join("\n"));

  const commentPlan = details(database, "SELECT COUNT(*) FROM post_comments WHERE post_id=? AND status='published'", 99);
  assert.ok(commentPlan.some((detail) => detail.includes("post_comments_post_status_id_idx")), commentPlan.join("\n"));

  const attendancePlan = details(database, `
    SELECT id,created_at FROM attendance
    WHERE attendance_date=? AND (created_at>? OR (created_at=? AND id>?))
    ORDER BY created_at,id LIMIT 101
  `, "2026-07-23", "2026-07-23T01:00:00.000Z", "2026-07-23T01:00:00.000Z", 100);
  assert.ok(attendancePlan.some((detail) => detail.includes("attendance_date_created_id_idx")), attendancePlan.join("\n"));
  assert.ok(!attendancePlan.some((detail) => detail.includes("TEMP B-TREE")), attendancePlan.join("\n"));
  database.close();
});

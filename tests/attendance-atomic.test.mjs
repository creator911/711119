import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AttendanceCommitConflict, commitAttendanceBatch } from "../app/lib/attendance-commit.ts";

class LocalStatement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new LocalStatement(this.database, this.query, values);
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }
}

class LocalD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new LocalStatement(this.database, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = this.database.prepare(statement.query).run(...statement.values);
        return { meta: { changes: Number(result.changes) } };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class AmbiguousCommitD1 extends LocalD1 {
  async batch(statements) {
    await super.batch(statements);
    throw new Error("injected lost response after commit");
  }
}

test("attendance and streak rewards commit in one retry-safe transaction", async () => {
  const [route, helper] = await Promise.all([
    readFile(new URL("../app/api/attendance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/attendance-commit.ts", import.meta.url), "utf8"),
  ]);
  const post = route.slice(route.indexOf("export async function POST"));

  assert.equal((helper.match(/await database\.batch\(/g) ?? []).length, 1);
  assert.match(post, /await commitAttendanceBatch\(env\.DB, attendanceStatements/);
  assert.doesNotMatch(post, /INSERT OR IGNORE INTO attendance_streak_rewards[\s\S]{0,250}\.run\(\)/);
  assert.match(post, /INSERT INTO attendance \(user_id,attendance_date,points_awarded,greeting,created_at\)/);
  assert.match(post, /INSERT OR IGNORE INTO attendance_streak_rewards/);
  assert.match(post, /UPDATE users[\s\S]*?type='attendance_streak_reward'/);
  assert.match(post, /INSERT INTO point_ledger\(user_id,amount,type,status,reference,created_at\)[\s\S]*?'attendance_streak_reward'/);
  assert.match(post, /reference LIKE \?/);
  assert.match(post, /for \(const reward of awardedRewards\)/);
  assert.doesNotMatch(post, /for \(const reward of eligibleRewards\)/);
  assert.match(post, /FROM users u[\s\S]*?u\.level=\?[\s\S]*?u\.level_locked=\?/);
  assert.ok((post.match(/\$\{attendanceCommitGuard\}/g) ?? []).length >= 6);
  assert.match(helper, /Number\(results\[0\]\?\.meta\?\.changes\) !== 1/);
  assert.match(helper, /catch \(batchError\)[\s\S]*?SELECT id FROM attendance[\s\S]*?created_at=\?[\s\S]*?points_awarded=\?/);
  assert.match(helper, /if \(!durableAttendance\) throw batchError/);
  assert.ok(post.indexOf("INSERT INTO attendance (user_id") < post.indexOf("commitAttendanceBatch(env.DB, attendanceStatements"));
  assert.ok(post.indexOf("INSERT OR IGNORE INTO attendance_streak_rewards") < post.indexOf("commitAttendanceBatch(env.DB, attendanceStatements"));
});

test("attendance commit recovers a lost response and rejects stale member state", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY,points INTEGER NOT NULL,level INTEGER NOT NULL,level_locked INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE attendance(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,attendance_date TEXT NOT NULL,points_awarded INTEGER NOT NULL,greeting TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,attendance_date));
      INSERT INTO users VALUES(1,0,1,0,'active');
    `);
    const ambiguous = new AmbiguousCommitD1(sqlite);
    const identity = { userId: 1, date: "2026-07-23", createdAt: "2026-07-23T00:00:00.000Z", points: 50 };
    const guard = "EXISTS(SELECT 1 FROM attendance WHERE user_id=? AND attendance_date=? AND created_at=? AND points_awarded=?)";
    const statements = [
      ambiguous.prepare(`
        INSERT INTO attendance(user_id,attendance_date,points_awarded,greeting,created_at)
        SELECT ?,?,?,?,? FROM users WHERE id=? AND status='active' AND level=? AND level_locked=?
      `).bind(1, identity.date, identity.points, "hello", identity.createdAt, 1, 1, 0),
      ambiguous.prepare(`UPDATE users SET points=points+? WHERE id=? AND ${guard}`)
        .bind(identity.points, 1, 1, identity.date, identity.createdAt, identity.points),
    ];
    await commitAttendanceBatch(ambiguous, statements, identity);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM attendance").get().count, 1);
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 50);

    sqlite.prepare("UPDATE users SET level=4,level_locked=1 WHERE id=1").run();
    const current = new LocalD1(sqlite);
    const staleIdentity = { userId: 1, date: "2026-07-24", createdAt: "2026-07-24T00:00:00.000Z", points: 50 };
    const staleStatements = [
      current.prepare(`
        INSERT INTO attendance(user_id,attendance_date,points_awarded,greeting,created_at)
        SELECT ?,?,?,?,? FROM users WHERE id=? AND status='active' AND level=? AND level_locked=?
      `).bind(1, staleIdentity.date, staleIdentity.points, "hello", staleIdentity.createdAt, 1, 1, 0),
      current.prepare(`UPDATE users SET points=points+? WHERE id=? AND ${guard}`)
        .bind(staleIdentity.points, 1, 1, staleIdentity.date, staleIdentity.createdAt, staleIdentity.points),
    ];
    await assert.rejects(() => commitAttendanceBatch(current, staleStatements, staleIdentity), AttendanceCommitConflict);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM attendance WHERE attendance_date='2026-07-24'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 50);
  } finally {
    sqlite.close();
  }
});

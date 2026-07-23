import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationSource = await readFile(
  new URL("../drizzle/0041_moaning_demogoblin.sql", import.meta.url),
  "utf8",
);
const migrationStatements = migrationSource
  .split(/-->\s*statement-breakpoint/)
  .map((statement) => statement.trim())
  .filter(Boolean);

const statementContaining = (...fragments) => {
  const statement = migrationStatements.find((candidate) => fragments.every((fragment) => candidate.includes(fragment)));
  assert.ok(statement, `missing migration statement: ${fragments.join(", ")}`);
  return statement;
};

const attendanceBalanceRepair = statementContaining("UPDATE users", "attendance_streak_rewards");
const attendanceLedgerRepair = statementContaining("INSERT INTO point_ledger", "attendance_streak_rewards");
const eventBalanceRepair = statementContaining("UPDATE users", "SET points=points+COALESCE", "event_reward_payouts");
const eventLedgerRepair = statementContaining("INSERT OR IGNORE INTO point_ledger", "event_reward_payouts");
const partnerInsertTrigger = statementContaining("CREATE TRIGGER users_partner_requires_director_after_insert");
const partnerUpdateTrigger = statementContaining("CREATE TRIGGER users_partner_requires_director_after_update");

const planDetails = (database, statement) => database
  .prepare(`EXPLAIN QUERY PLAN ${statement}`)
  .all()
  .map(({ detail }) => String(detail));

test("100k-member recovery writes target affected primary keys and remain idempotent", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users(
        id INTEGER PRIMARY KEY,
        points INTEGER NOT NULL DEFAULT 0,
        is_director INTEGER NOT NULL DEFAULT 0,
        is_partner INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE attendance_streak_rewards(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        milestone_days INTEGER NOT NULL,
        points INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX attendance_streak_rewards_user_milestone_unique
        ON attendance_streak_rewards(user_id,milestone_days);
      CREATE TABLE event_reward_payouts(
        id INTEGER PRIMARY KEY,
        period_type TEXT NOT NULL,
        board_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        points INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX event_reward_payouts_period_user_unique
        ON event_reward_payouts(period_type,board_type,period_start,user_id);
      CREATE UNIQUE INDEX event_reward_payouts_period_rank_unique
        ON event_reward_payouts(period_type,board_type,period_start,rank);
      CREATE INDEX event_reward_payouts_period_rank_idx
        ON event_reward_payouts(period_type,board_type,period_start,rank);
      CREATE TABLE point_ledger(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        reference TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX point_ledger_event_reward_user_reference_unique
        ON point_ledger(user_id,type,reference)
        WHERE type='event_reward' AND reference IS NOT NULL;
      CREATE INDEX point_ledger_attendance_streak_user_reference_idx
        ON point_ledger(user_id,reference)
        WHERE type='attendance_streak_reward';

      WITH RECURSIVE sequence(value) AS (
        VALUES(1) UNION ALL SELECT value+1 FROM sequence WHERE value<100000
      )
      INSERT INTO users(id) SELECT value FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        VALUES(99901) UNION ALL SELECT value+1 FROM sequence WHERE value<100000
      )
      INSERT INTO attendance_streak_rewards(user_id,milestone_days,points,created_at)
      SELECT value,10,1000,'2026-07-22T00:00:00.000Z' FROM sequence;

      INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
      VALUES(99901,1000,'attendance_streak_reward','complete','streak:10:2026-07-22','2026-07-22T00:00:00.000Z');

      INSERT INTO event_reward_payouts(period_type,board_type,period_start,user_id,rank,points) VALUES
        ('weekly','posts','2026-07-12T15:00:00.000Z',99801,1,10000),
        ('weekly','posts','2026-07-12T15:00:00.000Z',99802,2,5000),
        ('weekly','posts','2026-07-12T15:00:00.000Z',99803,3,1000);
      INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
      VALUES(99801,10000,'event_reward','complete','event:weekly:posts:2026-07-13:rank1','2026-07-22T00:00:00.000Z');
    `);
    database.exec(partnerInsertTrigger);
    database.exec(partnerUpdateTrigger);

    const attendancePlan = planDetails(database, attendanceBalanceRepair);
    assert.ok(attendancePlan.some((detail) => detail.includes("SEARCH users USING INTEGER PRIMARY KEY")), attendancePlan.join("\n"));
    assert.ok(attendancePlan.some((detail) => detail.includes("point_ledger_attendance_streak_user_reference_idx")), attendancePlan.join("\n"));
    assert.ok(!attendancePlan.some((detail) => /^SCAN users(?:\s|$)/.test(detail)), attendancePlan.join("\n"));

    const eventPlan = planDetails(database, eventBalanceRepair);
    assert.ok(eventPlan.some((detail) => detail.includes("SEARCH users USING INTEGER PRIMARY KEY")), eventPlan.join("\n"));
    assert.ok(eventPlan.some((detail) => detail.includes("point_ledger_event_reward_user_reference_unique")), eventPlan.join("\n"));
    assert.ok(!eventPlan.some((detail) => /^SCAN users(?:\s|$)/.test(detail)), eventPlan.join("\n"));

    const partnerWritePlan = database.prepare("EXPLAIN QUERY PLAN UPDATE users SET is_partner=1 WHERE id=?").all(50000)
      .map(({ detail }) => String(detail));
    assert.ok(partnerWritePlan.some((detail) => detail.includes("SEARCH users USING INTEGER PRIMARY KEY")), partnerWritePlan.join("\n"));
    assert.ok(!partnerWritePlan.some((detail) => /^SCAN users(?:\s|$)/.test(detail)), partnerWritePlan.join("\n"));

    const startedAt = performance.now();
    database.exec("BEGIN IMMEDIATE");
    for (const statement of [attendanceBalanceRepair, attendanceLedgerRepair, eventBalanceRepair, eventLedgerRepair]) {
      database.exec(statement);
    }
    database.exec("COMMIT");
    const elapsedMs = performance.now() - startedAt;

    assert.equal(database.prepare("SELECT points FROM users WHERE id=99901").get().points, 0, "legacy streak ledger suppresses duplicate points");
    assert.equal(database.prepare("SELECT points FROM users WHERE id=99902").get().points, 1000);
    assert.equal(database.prepare("SELECT points FROM users WHERE id=99801").get().points, 0, "existing event ledger suppresses duplicate points");
    assert.equal(database.prepare("SELECT points FROM users WHERE id=99802").get().points, 5000);
    assert.equal(database.prepare("SELECT points FROM users WHERE id=99803").get().points, 1000);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE type='attendance_streak_reward'").get().count, 100);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE type='event_reward'").get().count, 3);
    assert.throws(() => database.prepare(`
      INSERT INTO event_reward_payouts(period_type,board_type,period_start,user_id,rank,points)
      VALUES('weekly','posts','2026-07-12T15:00:00.000Z',99799,1,10000)
    `).run(), /UNIQUE constraint failed/, "the same period rank can never acquire a second owner");

    const pointTotal = database.prepare("SELECT SUM(points) AS total FROM users").get().total;
    database.exec("BEGIN IMMEDIATE");
    for (const statement of [attendanceBalanceRepair, attendanceLedgerRepair, eventBalanceRepair, eventLedgerRepair]) {
      database.exec(statement);
    }
    database.exec("COMMIT");
    assert.equal(database.prepare("SELECT SUM(points) AS total FROM users").get().total, pointTotal, "recovery rerun must not pay twice");

    database.prepare("UPDATE users SET is_partner=1 WHERE id=?").run(50000);
    assert.deepEqual({ ...database.prepare("SELECT is_director,is_partner FROM users WHERE id=50000").get() }, {
      is_director: 1,
      is_partner: 1,
    });
    database.prepare("UPDATE users SET is_director=0 WHERE id=?").run(50000);
    assert.equal(database.prepare("SELECT is_director FROM users WHERE id=50000").get().is_director, 1);

    console.log(`100k member recovery + ledger repair: ${elapsedMs.toFixed(2)}ms`);
  } finally {
    database.close();
  }
});

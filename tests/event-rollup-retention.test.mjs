import assert from "node:assert/strict";
import test from "node:test";
import { openD1Database } from "../server/d1-sqlite.mjs";
import { enqueueSettledRollupCleanup, pruneSettledEventRollups } from "../app/lib/event-rollup-retention.ts";

test("settled event rollups are queued and pruned in bounded batches", async () => {
  const database = openD1Database(":memory:");
  database._execSync(`
    CREATE TABLE site_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE event_activity_rollups(period_type TEXT NOT NULL,period_start TEXT NOT NULL,board_type TEXT NOT NULL,user_id INTEGER NOT NULL,activity_count INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE event_rollup_cleanup_queue(id INTEGER PRIMARY KEY AUTOINCREMENT,period_type TEXT NOT NULL,period_start TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX event_rollup_cleanup_period_unique ON event_rollup_cleanup_queue(period_type,period_start);
    CREATE INDEX event_rollup_cleanup_created_idx ON event_rollup_cleanup_queue(created_at,id);
  `);
  const period = {
    type: "weekly",
    startAt: "2026-07-05T15:00:00.000Z",
    endAt: "2026-07-12T15:00:00.000Z",
    label: "test",
  };
  database._execSync(`
    INSERT INTO site_settings VALUES
      ('event_reward_settled:weekly:posts:2026-07-05T15:00:00.000Z','complete:3','test','2026-07-12T15:00:00.000Z'),
      ('event_reward_settled:weekly:comments:2026-07-05T15:00:00.000Z','complete:3','test','2026-07-12T15:00:00.000Z');
    WITH RECURSIVE ids(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM ids WHERE value<6001)
    INSERT INTO event_activity_rollups
      SELECT 'weekly','2026-07-05T15:00:00.000Z','posts',value,1,'2026-07-12T15:00:00.000Z' FROM ids;
  `);

  await enqueueSettledRollupCleanup(database, period, new Date("2026-07-13T00:00:00.000Z"));
  assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_rollup_cleanup_queue")[0].count, 1);
  await pruneSettledEventRollups(database);
  assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_activity_rollups")[0].count, 1001);
  assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_rollup_cleanup_queue")[0].count, 1);
  await pruneSettledEventRollups(database);
  assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_activity_rollups")[0].count, 0);
  assert.equal(database._allSync("SELECT COUNT(*) AS count FROM event_rollup_cleanup_queue")[0].count, 0);
  database.close();
});

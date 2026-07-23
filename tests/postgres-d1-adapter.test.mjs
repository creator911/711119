import test from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import {
  openPostgresD1Database,
  translateSqliteSql,
} from "../server/d1-postgres.mjs";

test("SQLite query compatibility translation preserves bindings and conflict behavior", () => {
  assert.equal(
    translateSqliteSql("SELECT * FROM users INDEXED BY users_name WHERE username=? COLLATE NOCASE"),
    "SELECT * FROM users WHERE LOWER(username) = LOWER($1)",
  );
  assert.equal(
    translateSqliteSql("SELECT instr(lower(title),lower(?)) AS found FROM posts"),
    "SELECT strpos(lower(title),lower($1)) AS found FROM posts",
  );
  assert.equal(
    translateSqliteSql("SELECT username FROM users ORDER BY username COLLATE NOCASE ASC,id"),
    "SELECT username FROM users ORDER BY LOWER(username) ASC,id",
  );
  assert.equal(
    translateSqliteSql("CREATE INDEX users_username_idx ON users(username COLLATE NOCASE,id)"),
    "CREATE INDEX users_username_idx ON users(LOWER(username),id)",
  );
  assert.match(
    translateSqliteSql("INSERT OR IGNORE INTO point_ledger(user_id,reference) VALUES(?,?)"),
    /ON CONFLICT DO NOTHING$/,
  );
  assert.match(
    translateSqliteSql("DELETE FROM jobs WHERE rowid IN(SELECT rowid FROM jobs LIMIT ?)"),
    /ctid IN\(SELECT ctid FROM jobs LIMIT \$1\)/,
  );
});

test("PostgreSQL adapter exposes D1 first/all/run/batch contracts", async () => {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await pool.query(`
    CREATE TABLE users(
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      points BIGINT NOT NULL DEFAULT 0
    )
  `);
  const database = openPostgresD1Database(null, { pool, ssl: false });
  const inserted = await database.prepare("INSERT INTO users(username,points) VALUES(?,?)").bind("Member", 10).run();
  assert.equal(inserted.meta.changes, 1);
  assert.equal(inserted.meta.last_row_id, 1);
  assert.deepEqual(
    await database.prepare("SELECT id,username,points FROM users WHERE username=? COLLATE NOCASE").bind("member").first(),
    { id: 1, username: "Member", points: 10 },
  );
  const ignored = await database.prepare("INSERT OR IGNORE INTO users(username,points) VALUES(?,?)").bind("Member", 99).run();
  assert.equal(ignored.meta.changes, 0);
  const results = await database.batch([
    database.prepare("UPDATE users SET points=points+? WHERE id=?").bind(5, 1),
    database.prepare("SELECT points FROM users WHERE id=?").bind(1),
  ]);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(results[1].results[0].points, 15);
  await pool.end();
});

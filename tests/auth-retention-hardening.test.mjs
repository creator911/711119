import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  activeLoginFailure,
  LOGIN_FAILURE_IDLE_RESET_MS,
  pruneLoginFailures,
} from "../app/lib/admin-login-failures.ts";
import {
  MEMBER_ACCOUNT_BLOCK_MS,
  activeMemberAccountFailure,
  recordMemberPasswordFailure,
} from "../app/lib/member-login-failures.ts";
import {
  pruneExpiredAnnouncementReceipts,
  pruneExpiredSessions,
} from "../app/lib/auth-maintenance.ts";

function asyncDatabase(database) {
  return {
    prepare(query) {
      const statement = database.prepare(query);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
}

function createFailureTables(sqlite) {
  for (const prefix of ["admin_ip", "admin_account", "member_ip", "member_account"]) {
    const key = prefix.endsWith("_ip") ? "ip" : "username";
    sqlite.exec(`CREATE TABLE ${prefix}_login_failures (${key} TEXT PRIMARY KEY, failure_count INTEGER NOT NULL DEFAULT 0, blocked_until TEXT, updated_at TEXT NOT NULL)`);
    sqlite.exec(`CREATE INDEX ${prefix}_login_failures_updated_idx ON ${prefix}_login_failures(updated_at,${key})`);
  }
}

test("member login failures throttle accounts and reset an idle, non-blocked counter", async () => {
  const sqlite = new DatabaseSync(":memory:");
  createFailureTables(sqlite);
  const database = asyncDatabase(sqlite);
  const now = Date.parse("2026-07-23T00:00:00.000Z");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await recordMemberPasswordFailure(database, "198.51.100.10", "member-a", now + attempt);
    assert.equal(result.accountBlockedUntil, null);
  }
  const blocked = await recordMemberPasswordFailure(database, "198.51.100.10", "member-a", now + 4);
  assert.equal(Date.parse(blocked.accountBlockedUntil), now + 4 + MEMBER_ACCOUNT_BLOCK_MS);
  assert.ok((await activeMemberAccountFailure(database, "member-a", now + 5))?.blocked_until);

  await recordMemberPasswordFailure(database, "198.51.100.20", "member-b", now + 10);
  assert.equal(
    await activeLoginFailure(
      database,
      "member_account_login_failures",
      "username",
      "member-b",
      now + 10 + LOGIN_FAILURE_IDLE_RESET_MS + 1,
      LOGIN_FAILURE_IDLE_RESET_MS,
    ),
    null,
  );
  sqlite.close();
});

test("stale login failure pruning is bounded independently per table", async () => {
  const sqlite = new DatabaseSync(":memory:");
  createFailureTables(sqlite);
  const database = asyncDatabase(sqlite);
  const old = "2020-01-01T00:00:00.000Z";
  for (const index of [1, 2, 3]) {
    sqlite.prepare("INSERT INTO admin_ip_login_failures(ip,failure_count,updated_at) VALUES(?,1,?)").run(`ip-${index}`, old);
    sqlite.prepare("INSERT INTO admin_account_login_failures(username,failure_count,updated_at) VALUES(?,1,?)").run(`user-${index}`, old);
  }
  const plan = sqlite.prepare(`
    EXPLAIN QUERY PLAN
    SELECT rowid FROM admin_ip_login_failures
    WHERE updated_at<=?
    ORDER BY updated_at,ip
    LIMIT ?
  `).all("2026-07-23T00:00:00.000Z", 500).map((row) => String(row.detail));
  assert.ok(plan.some((detail) => detail.includes("admin_ip_login_failures_updated_idx")));
  assert.ok(!plan.some((detail) => detail.includes("TEMP B-TREE")));
  await pruneLoginFailures(database, "admin", Date.parse("2026-07-23T00:00:00.000Z"), 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_ip_login_failures").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_account_login_failures").get().count, 1);
  sqlite.close();
});

test("expired session cleanup uses a bounded oldest-first delete", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,ip TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX sessions_expires_token_idx ON sessions(expires_at,token)");
  const insert = sqlite.prepare("INSERT INTO sessions VALUES(?,1,'127.0.0.1',?,?)");
  insert.run("expired-1", "2026-07-20T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  insert.run("expired-2", "2026-07-21T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  insert.run("expired-3", "2026-07-22T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  insert.run("active", "2026-07-24T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  await pruneExpiredSessions(asyncDatabase(sqlite), new Date("2026-07-23T00:00:00.000Z"), 2);
  assert.deepEqual(sqlite.prepare("SELECT token FROM sessions ORDER BY token").all().map((row) => row.token), ["active", "expired-3"]);
  sqlite.close();
});

test("announcement receipt cleanup removes only expired or cancelled deliveries and stays bounded", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE system_announcements(id INTEGER PRIMARY KEY,ends_at TEXT NOT NULL,status TEXT NOT NULL);
    CREATE INDEX system_announcements_ends_id_idx ON system_announcements(ends_at,id);
    CREATE TABLE system_announcement_receipts(id INTEGER PRIMARY KEY,announcement_id INTEGER NOT NULL,user_id INTEGER NOT NULL,delivered_at TEXT NOT NULL,acknowledged_at TEXT);
    CREATE UNIQUE INDEX system_announcement_receipts_announcement_user_unique ON system_announcement_receipts(announcement_id,user_id);
    INSERT INTO system_announcements VALUES
      (1,'2026-07-22T00:00:00.000Z','active'),
      (2,'2026-07-30T00:00:00.000Z','cancelled'),
      (3,'2026-07-30T00:00:00.000Z','active');
  `);
  for (let announcementId = 1; announcementId <= 3; announcementId += 1) {
    for (let userId = 1; userId <= 3; userId += 1) {
      sqlite.prepare("INSERT INTO system_announcement_receipts(announcement_id,user_id,delivered_at) VALUES(?,?,'2026-07-20T00:00:00.000Z')").run(announcementId, userId);
    }
  }
  const database = asyncDatabase(sqlite);
  await pruneExpiredAnnouncementReceipts(database, new Date("2026-07-23T00:00:00.000Z"), 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM system_announcement_receipts").get().count, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM system_announcement_receipts WHERE announcement_id=3").get().count, 3);
  await pruneExpiredAnnouncementReceipts(database, new Date("2026-07-23T00:00:00.000Z"), 10);
  assert.deepEqual(
    sqlite.prepare("SELECT DISTINCT announcement_id AS id FROM system_announcement_receipts ORDER BY id").all().map((row) => Number(row.id)),
    [3],
  );
  sqlite.close();
});

test("login routes gate PBKDF2 and wire bounded maintenance", async () => {
  const [memberRoute, adminRoute, announcementRoute, schema, migration, snapshotSource] = await Promise.all([
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/next/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0043_yummy_the_fury.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/0043_snapshot.json", import.meta.url), "utf8"),
  ]);
  const snapshot = JSON.parse(snapshotSource);
  const handler = memberRoute.slice(memberRoute.indexOf("export async function POST"));
  assert.ok(handler.indexOf("activeMemberIpFailure") < handler.indexOf("request.json()"));
  assert.ok(handler.indexOf("activeMemberAccountFailure") < handler.indexOf("hashPassword(password"));
  assert.match(memberRoute, /user \? bytes\(user\.password_salt\) : DUMMY_SALT/);
  assert.match(memberRoute, /recordMemberPasswordFailure/);
  assert.match(memberRoute, /pruneExpiredSessions/);
  assert.match(memberRoute, /const accountKey = String\(user\?\.username \?\? username\)/);
  assert.doesNotMatch(memberRoute, /accountKey = [^\n]*toLowerCase/);
  assert.match(memberRoute, /shouldRunMemberLoginMaintenance/);
  assert.match(adminRoute, /pruneLoginFailures\(env\.DB, "admin"\)/);
  assert.match(announcementRoute, /maybePruneExpiredAnnouncementReceipts/);
  for (const expected of [
    "sessions_expires_token_idx",
    "member_ip_login_failures",
    "member_account_login_failures",
    "system_announcements_ends_id_idx",
  ]) {
    assert.match(schema, new RegExp(expected));
    assert.match(migration, new RegExp(expected));
  }
  assert.ok(snapshot.tables.member_ip_login_failures);
  assert.ok(snapshot.tables.member_account_login_failures);
  assert.ok(snapshot.tables.sessions.indexes.sessions_expires_token_idx);
  assert.ok(snapshot.tables.system_announcements.indexes.system_announcements_ends_id_idx);
});

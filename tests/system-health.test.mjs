import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSystemHealth, REQUIRED_RUNTIME_SCHEMA_OBJECTS } from "../app/lib/system-health.ts";
import { openD1Database } from "../server/d1-sqlite.mjs";
import { applyMigrations } from "../server/migrate.mjs";

function databaseWithObjects(objects, { ping = 1, fail = false } = {}) {
  return {
    prepare(query) {
      if (fail) throw new Error("database unavailable");
      if (query === "SELECT 1 AS ok") return { first: async () => ({ ok: ping }), all: async () => ({ results: [] }), bind() { return this; } };
      assert.match(query, /sqlite_master/);
      return {
        first: async () => null,
        all: async () => ({ results: [] }),
        bind: (...expected) => {
          assert.deepEqual(expected, [...REQUIRED_RUNTIME_SCHEMA_OBJECTS]);
          return { all: async () => ({ results: objects.map((name) => ({ name })) }) };
        },
      };
    },
  };
}

test("system health reports healthy only when database and required schema objects are ready", async () => {
  const health = await loadSystemHealth(databaseWithObjects([...REQUIRED_RUNTIME_SCHEMA_OBJECTS]));
  assert.equal(health.status, "healthy");
  assert.equal(health.database, "ok");
  assert.equal(health.migrations, "ready");
  assert.equal(health.application, "ready");
  assert.equal(health.missingSchemaObjects, 0);
});

test("system health reports an outdated migration without exposing object names", async () => {
  const health = await loadSystemHealth(databaseWithObjects(REQUIRED_RUNTIME_SCHEMA_OBJECTS.slice(0, -2)));
  assert.equal(health.status, "degraded");
  assert.equal(health.database, "ok");
  assert.equal(health.migrations, "outdated");
  assert.equal(health.application, "not_ready");
  assert.equal(health.missingSchemaObjects, 2);
  assert.equal(Object.hasOwn(health, "missingObjects"), false);
});

test("system health requires every runtime-critical 0043 index before reporting ready", async () => {
  const criticalIndexes = [
    "event_rollup_cleanup_period_unique",
    "event_rollup_cleanup_created_idx",
    "member_account_login_failures_updated_idx",
    "member_ip_login_failures_updated_idx",
    "admin_account_login_failures_updated_idx",
    "admin_ip_login_failures_updated_idx",
    "attendance_date_created_id_idx",
    "point_ledger_content_reward_user_reference_unique",
    "posts_draft_created_id_idx",
    "post_comments_pending_created_id_idx",
  ];
  for (const indexName of criticalIndexes) {
    assert.ok(REQUIRED_RUNTIME_SCHEMA_OBJECTS.includes(indexName), `${indexName} must be required`);
    const health = await loadSystemHealth(databaseWithObjects(REQUIRED_RUNTIME_SCHEMA_OBJECTS.filter((name) => name !== indexName)));
    assert.equal(health.status, "degraded", `${indexName} must gate readiness`);
    assert.equal(health.missingSchemaObjects, 1);
  }
});

test("system health returns a stable unavailable response when the database fails", async () => {
  const health = await loadSystemHealth(databaseWithObjects([], { fail: true }));
  assert.equal(health.status, "unavailable");
  assert.equal(health.database, "error");
  assert.equal(health.migrations, "unknown");
  assert.equal(health.application, "not_ready");
});

test("the fully migrated production schema satisfies runtime health readiness", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nara-health-"));
  const database = openD1Database(path.join(directory, "health.sqlite"));
  try {
    applyMigrations(database);
    const health = await loadSystemHealth(database);
    assert.equal(health.status, "healthy");
    assert.equal(health.missingSchemaObjects, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

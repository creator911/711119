import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openD1Database } from "../server/d1-sqlite.mjs";
import { applyMigrations } from "../server/migrate.mjs";
import {
  indexDefinitions,
  tableDefinitions,
} from "../server/postgres/migrate-from-sqlite.mjs";

test("PostgreSQL schema conversion preserves checks, unique indexes, and case-insensitive prefix indexes", () => {
  const database = openD1Database(":memory:");
  try {
    applyMigrations(database);
    const tables = tableDefinitions(database);
    const checks = tables.flatMap((table) => table.definitions.filter((definition) => definition.includes(" CHECK ")));
    assert.ok(checks.length >= 16);
    for (const name of [
      "outbox_jobs_status_check",
      "shop_products_stock_check",
      "shop_products_min_level_check",
      "system_announcements_window_check",
      "uploaded_media_status_check",
    ]) {
      assert.ok(checks.some((definition) => definition.includes(`"${name}"`)), `${name} is missing`);
    }
    const sourceIndexes = database._allSync(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    `);
    const indexes = indexDefinitions(database);
    assert.ok(indexes.length >= sourceIndexes.length);
    const noCaseIndexes = indexes.filter((index) => index.nocase);
    assert.ok(noCaseIndexes.length >= 3);
    assert.ok(noCaseIndexes.every((index) => index.sql.includes("text_pattern_ops")));
    assert.ok(noCaseIndexes.every((index) => !index.sql.includes("COLLATE NOCASE")));
  } finally {
    database.close();
  }
});

test("PostgreSQL migration installs concurrency-safe runtime triggers for every critical ledger", async () => {
  const source = await readFile(new URL("../server/postgres/migrate-from-sqlite.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /AFTER INSERT OR UPDATE OF/);
  for (const trigger of [
    "shop_purchase_validate_before_insert",
    "shop_purchase_apply_after_insert",
    "shop_voucher_purchase_validate_before_update",
    "shop_purchase_links_validate_before_update",
    "event_activity_posts_insert",
    "event_activity_comments_insert",
    "event_activity_attendance_insert",
    "member_activity_attendance_insert",
    "member_activity_post_insert",
    "member_activity_comment_insert",
    "support_stats_reply_insert",
    "users_partner_requires_director_after_update",
    "featured_vendor_posts_prevent_delete",
  ]) {
    assert.match(source, new RegExp(`CREATE TRIGGER ${trigger}\\b`), `${trigger} is missing`);
  }
  assert.match(source, /FROM users WHERE id=NEW\.user_id FOR UPDATE/);
  assert.match(source, /FROM shop_products WHERE id=NEW\.product_id FOR UPDATE/);
  assert.match(source, /VALIDATE CONSTRAINT/);
  assert.match(source, /nara_schema_migrations/);
});

test("PostgreSQL cutover verifies deterministic source and target checksums", async () => {
  const source = await readFile(new URL("../server/postgres/migrate-from-sqlite.mjs", import.meta.url), "utf8");
  assert.match(source, /stableOrderColumns/);
  assert.match(source, /DECLARE \$\{cursorName\} NO SCROLL CURSOR/);
  assert.match(source, /sourceChecksum/);
  assert.match(source, /targetChecksum/);
  assert.match(source, /Checksum mismatch for/);
  assert.match(source, /checksumMatch:\s*true/);
  assert.match(source, /verifyCriticalAudit/);
  assert.match(source, /users_points/);
  assert.match(source, /ledger_amount/);
  assert.match(source, /owners_active/);
  assert.match(source, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(source, /vendor_posts_search_trgm_idx/);
});

test("PostgreSQL runtime roles separate public, admin, and worker access", async () => {
  const source = await readFile(new URL("../server/postgres/provision-roles.mjs", import.meta.url), "utf8");
  assert.match(source, /SELECT current_database\(\) AS name/);
  assert.match(source, /REVOKE ALL ON ALL TABLES/);
  assert.match(
    source.replace(/\s+/g, " "),
    /REVOKE ALL ON TABLE admin_owners,admin_account_login_failures,admin_ip_login_failures/,
  );
  assert.match(source, /workerTables/);
  assert.match(source, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(source, /ALTER DEFAULT PRIVILEGES/);
});

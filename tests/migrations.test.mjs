import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("모든 Drizzle 마이그레이션이 신규 DB에 순서대로 적용된다", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.deepEqual(journal.entries.map((entry) => entry.idx), Array.from({ length: 25 }, (_, index) => index));
  assert.equal(journal.entries.at(-1)?.tag, "0024_lonely_robbie_robertson");

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/).map((value) => value.trim()).filter(Boolean)) {
      database.exec(statement);
    }
  }

  const snapshot = JSON.parse(await readFile(new URL("../drizzle/meta/0024_snapshot.json", import.meta.url), "utf8"));
  const actualTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  assert.deepEqual(actualTables, Object.keys(snapshot.tables).sort());

  const expectedTodayTables = [
    "admin_account_login_failures", "admin_ip_login_failures", "admin_owners",
    "director_regions", "featured_vendor_permissions", "featured_vendor_posts",
    "post_poll_options", "post_poll_votes", "post_polls", "shop_products", "shop_purchases", "shop_vouchers", "upload_usage", "uploaded_media", "uploaded_media_references", "vendor_posts",
  ];
  for (const table of expectedTodayTables) assert.ok(actualTables.includes(table), `${table} table is missing`);

  const supportColumns = database.prepare("PRAGMA table_info(support_inquiries)").all().map(({ name }) => name);
  assert.ok(supportColumns.includes("kind"));
  assert.ok(supportColumns.includes("shop_purchase_id"));
  const postColumns = database.prepare("PRAGMA table_info(posts)").all().map(({ name }) => name);
  assert.ok(postColumns.includes("is_pinned"));
  const postIndexes = database.prepare("PRAGMA index_list(posts)").all().map(({ name }) => name);
  assert.ok(postIndexes.includes("posts_category_status_created_idx"));
  const userColumns = database.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
  assert.ok(userColumns.includes("is_director"));
  assert.ok(userColumns.includes("is_partner"));

  assert.deepEqual(database.prepare("SELECT username FROM admin_owners ORDER BY username").all(), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM featured_vendor_posts").get().count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_products").get().count, 10);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'shop_purchase_%' ORDER BY name").all().map(({ name }) => name), ["shop_purchase_apply_after_insert", "shop_purchase_links_validate_before_update", "shop_purchase_validate_before_insert"]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('shop_voucher_purchase_validate_before_update','shop_voucher_state_validate_before_insert','shop_support_purchase_validate_before_insert','shop_support_purchase_validate_before_update') ORDER BY name").all().map(({ name }) => name), ["shop_support_purchase_validate_before_insert", "shop_support_purchase_validate_before_update", "shop_voucher_purchase_validate_before_update", "shop_voucher_state_validate_before_insert"]);
  assert.throws(() => database.prepare("DELETE FROM featured_vendor_posts WHERE slot=1").run(), /fixed_featured_vendor_post_cannot_be_deleted/);
  database.close();
});

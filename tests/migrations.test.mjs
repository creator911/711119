import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("모든 Drizzle 마이그레이션이 신규 DB에 순서대로 적용된다", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.deepEqual(journal.entries.map((entry) => entry.idx), Array.from({ length: 32 }, (_, index) => index));
  assert.equal(journal.entries.at(-1)?.tag, "0031_slippery_ken_ellis");

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const entry of journal.entries) {
    if (entry.tag === "0026_mighty_gravity") {
      const legacyPost = database.prepare("INSERT INTO posts(category,title,body,author_id,created_at) VALUES(?,?,?,?,?)");
      legacyPost.run("community", "기존 커뮤니티 글", "본문", 0, "2026-07-21T00:00:00.000Z");
      legacyPost.run("gifs", "기존 짤공유 글", "본문", 0, "2026-07-21T00:00:00.000Z");
      legacyPost.run("reviews", "기존 후기 글", "본문", 0, "2026-07-21T00:00:00.000Z");
    }
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/).map((value) => value.trim()).filter(Boolean)) {
      database.exec(statement);
    }
  }

  const latestSnapshotName = `${String(journal.entries.at(-1)?.idx).padStart(4, "0")}_snapshot.json`;
  const snapshot = JSON.parse(await readFile(new URL(`../drizzle/meta/${latestSnapshotName}`, import.meta.url), "utf8"));
  const actualTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  assert.deepEqual(actualTables, Object.keys(snapshot.tables).sort());

  const expectedTodayTables = [
    "admin_account_login_failures", "admin_ip_login_failures", "admin_owners",
    "director_regions", "featured_vendor_permissions", "featured_vendor_posts",
    "post_poll_options", "post_poll_votes", "post_polls", "shop_products", "shop_purchases", "shop_vouchers", "site_settings", "system_announcement_receipts", "system_announcements", "upload_usage", "uploaded_media", "uploaded_media_references", "vendor_post_jump_usage", "vendor_posts",
  ];
  for (const table of expectedTodayTables) assert.ok(actualTables.includes(table), `${table} table is missing`);

  const supportColumns = database.prepare("PRAGMA table_info(support_inquiries)").all().map(({ name }) => name);
  assert.ok(supportColumns.includes("kind"));
  assert.ok(supportColumns.includes("shop_purchase_id"));
  const postColumns = database.prepare("PRAGMA table_info(posts)").all().map(({ name }) => name);
  assert.ok(postColumns.includes("is_pinned"));
  assert.ok(postColumns.includes("community_tag_mask"));
  assert.ok(postColumns.includes("title_color"));
  assert.ok(postColumns.includes("author_name"));
  const vendorColumns = database.prepare("PRAGMA table_info(vendor_posts)").all().map(({ name }) => name);
  assert.ok(vendorColumns.includes("title_color"));
  assert.ok(vendorColumns.includes("jumped_at"));
  assert.deepEqual(
    database.prepare("SELECT category,community_tag_mask AS communityTagMask FROM posts WHERE title LIKE '기존 %' ORDER BY category").all().map((row) => ({ ...row })),
    [
      { category: "community", communityTagMask: 4 },
      { category: "gifs", communityTagMask: 4 },
      { category: "reviews", communityTagMask: 0 },
    ],
  );
  const postIndexes = database.prepare("PRAGMA index_list(posts)").all().map(({ name }) => name);
  assert.ok(postIndexes.includes("posts_category_status_created_idx"));
  const userColumns = database.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
  assert.ok(userColumns.includes("is_director"));
  assert.ok(userColumns.includes("is_partner"));
  assert.ok(userColumns.includes("level_locked"));

  assert.deepEqual(database.prepare("SELECT username FROM admin_owners ORDER BY username").all(), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM featured_vendor_posts").get().count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_products").get().count, 10);
  assert.deepEqual({ ...database.prepare("SELECT value,updated_by AS updatedBy FROM site_settings WHERE key='main_domain'").get() }, { value: "https://nara001.co.kr", updatedBy: "system" });
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'shop_purchase_%' ORDER BY name").all().map(({ name }) => name), ["shop_purchase_apply_after_insert", "shop_purchase_links_validate_before_update", "shop_purchase_validate_before_insert"]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('shop_voucher_purchase_validate_before_update','shop_voucher_state_validate_before_insert','shop_support_purchase_validate_before_insert','shop_support_purchase_validate_before_update') ORDER BY name").all().map(({ name }) => name), ["shop_support_purchase_validate_before_insert", "shop_support_purchase_validate_before_update", "shop_voucher_purchase_validate_before_update", "shop_voucher_state_validate_before_insert"]);
  assert.throws(() => database.prepare("DELETE FROM featured_vendor_posts WHERE slot=1").run(), /fixed_featured_vendor_post_cannot_be_deleted/);
  database.close();
});

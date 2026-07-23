import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("모든 Drizzle 마이그레이션이 신규 DB에 순서대로 적용된다", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.deepEqual(journal.entries.map((entry) => entry.idx), Array.from({ length: 47 }, (_, index) => index));
  assert.equal(journal.entries.at(-1)?.tag, "0046_nostalgic_thor_girl");

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const entry of journal.entries) {
    if (entry.tag === "0026_mighty_gravity") {
      const legacyPost = database.prepare("INSERT INTO posts(category,title,body,author_id,created_at) VALUES(?,?,?,?,?)");
      legacyPost.run("community", "기존 커뮤니티 글", "본문", 0, "2026-07-21T00:00:00.000Z");
      legacyPost.run("gifs", "기존 짤공유 글", "본문", 0, "2026-07-21T00:00:00.000Z");
      legacyPost.run("reviews", "기존 후기 글", "본문", 0, "2026-07-21T00:00:00.000Z");
    }
    if (entry.tag === "0040_late_sprite") {
      const recentAt = new Date(Date.now() - 86_400_000).toISOString();
      const recentDate = recentAt.slice(0, 10);
      database.prepare(`
        INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,status,created_at)
        VALUES('rollup-backfill','rollup-backfill','hash','salt','192.0.2.40','active',?)
      `).run(recentAt);
      const userId = Number(database.prepare("SELECT id FROM users WHERE username='rollup-backfill'").get().id);
      database.prepare(`
        INSERT INTO posts(category,title,body,author_id,status,created_at)
        VALUES('community','rollup backfill post','body',?,'published',?)
      `).run(userId, recentAt);
      const postId = Number(database.prepare("SELECT last_insert_rowid() AS id").get().id);
      database.prepare(`
        INSERT INTO post_comments(post_id,user_id,body,status,created_at)
        VALUES(?,?,'rollup backfill comment','published',?)
      `).run(postId, userId, recentAt);
      database.prepare(`
        INSERT INTO attendance(user_id,attendance_date,created_at)
        VALUES(?,?,?)
      `).run(userId, recentDate, recentAt);
      database.prepare(`
        INSERT INTO posts(category,title,body,author_id,status,created_at)
        VALUES('community','old dummy post','body',?,'published','2020-01-02T01:00:00.000Z')
      `).run(userId);
      const oldPostId = Number(database.prepare("SELECT last_insert_rowid() AS id").get().id);
      database.prepare(`
        INSERT INTO post_comments(post_id,user_id,body,status,created_at)
        VALUES(?,?,'old dummy comment','published','2020-01-02T01:05:00.000Z')
      `).run(oldPostId, userId);
      database.prepare(`
        INSERT INTO attendance(user_id,attendance_date,created_at)
        VALUES(?,'2020-01-02','2020-01-02T01:10:00.000Z')
      `).run(userId);
    }
    if (entry.tag === "0041_moaning_demogoblin") {
      const userId = Number(database.prepare("SELECT id FROM users WHERE username='rollup-backfill'").get().id);
      database.prepare("UPDATE users SET points=5000,is_partner=1,is_director=0 WHERE id=?").run(userId);
      database.prepare(`
        INSERT INTO attendance_streak_rewards(user_id,milestone_days,points,created_at)
        VALUES(?,10,1000,'2026-07-22T02:00:00.000Z'),(?,30,5000,'2026-07-22T02:00:00.000Z')
      `).run(userId, userId);
      database.prepare(`
        INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
        VALUES(?,5000,'attendance_streak_reward','complete','streak:30:2026-07-22','2026-07-22T02:00:00.000Z')
      `).run(userId);
      database.prepare(`
        INSERT INTO event_reward_payouts(
          period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at
        ) VALUES('weekly','posts','2026-07-05T15:00:00.000Z','2026-07-12T15:00:00.000Z',?,1,20,10000,'rollup-backfill',1,'2026-07-12T15:00:01.000Z')
      `).run(userId);
      database.prepare(`
        INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,status,created_at)
        VALUES('duplicate-rank','duplicate-rank','hash','salt','192.0.2.42',10000,'active','2026-07-12T15:00:02.000Z')
      `).run();
      const duplicateRankUserId = Number(database.prepare("SELECT id FROM users WHERE username='duplicate-rank'").get().id);
      database.prepare(`
        INSERT INTO event_reward_payouts(
          period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at
        ) VALUES('weekly','posts','2026-07-05T15:00:00.000Z','2026-07-12T15:00:00.000Z',?,1,19,10000,'duplicate-rank',1,'2026-07-12T15:00:03.000Z')
      `).run(duplicateRankUserId);
      database.prepare(`
        INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
        VALUES(?,10000,'event_reward','complete','event:weekly:posts:2026-07-06:rank1','2026-07-12T15:00:04.000Z')
      `).run(duplicateRankUserId);
      database.prepare(`
        INSERT INTO site_settings(key,value,updated_by,updated_at)
        VALUES('event_reward_settled:weekly:posts:2026-07-05T15:00:00.000Z','complete:1','legacy','2026-07-12T15:00:02.000Z')
      `).run();
    }
    if (entry.tag === "0043_yummy_the_fury") {
      database.prepare(`
        INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,status,created_at)
        VALUES('duplicate-content','duplicate-content','hash','salt','192.0.2.43',20,'active','2026-07-22T04:00:00.000Z')
      `).run();
      const duplicateContentUserId = Number(database.prepare("SELECT id FROM users WHERE username='duplicate-content'").get().id);
      database.prepare(`
        INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
        VALUES(?,10,'post_create','complete','community:777','2026-07-22T04:00:00.000Z'),
              (?,10,'post_create','complete','community:777','2026-07-22T04:00:01.000Z')
      `).run(duplicateContentUserId, duplicateContentUserId);
      database.prepare(`
        INSERT OR IGNORE INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
        VALUES('weekly','2026-07-05T15:00:00.000Z','comments',?,1,'2026-07-12T15:00:00.000Z')
      `).run(duplicateContentUserId);
      database.prepare(`
        INSERT INTO site_settings(key,value,updated_by,updated_at)
        VALUES('event_reward_settled:weekly:comments:2026-07-05T15:00:00.000Z','complete:1','test','2026-07-12T15:00:02.000Z')
      `).run();
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
    "event_activity_rollups", "event_rollup_cleanup_queue",
    "member_account_login_failures", "member_ip_login_failures",
    "member_activity_stats", "outbox_jobs", "post_poll_options", "post_poll_votes", "post_polls", "post_stats",
    "shop_products", "shop_purchases", "shop_vouchers", "site_settings", "support_stats", "support_write_rate_limits",
    "system_announcement_receipts", "system_announcements", "upload_usage", "uploaded_media", "uploaded_media_references",
    "vendor_post_jump_usage", "vendor_posts",
  ];
  for (const table of expectedTodayTables) assert.ok(actualTables.includes(table), `${table} table is missing`);

  const supportColumns = database.prepare("PRAGMA table_info(support_inquiries)").all().map(({ name }) => name);
  assert.ok(supportColumns.includes("kind"));
  assert.ok(supportColumns.includes("shop_purchase_id"));
  const supportIndexes = database.prepare("PRAGMA index_list(support_inquiries)").all().map(({ name }) => name);
  for (const indexName of ["support_inquiries_member_kind_id_idx", "support_inquiries_admin_kind_status_updated_idx", "support_inquiries_admin_priority_idx", "support_inquiries_admin_title_nocase_idx"]) assert.ok(supportIndexes.includes(indexName));
  const supportReplyIndexes = database.prepare("PRAGMA index_list(support_inquiry_replies)").all().map(({ name }) => name);
  assert.ok(supportReplyIndexes.includes("support_inquiry_replies_inquiry_id_idx"));
  const supportRateLimitIndexes = database.prepare("PRAGMA index_list(support_write_rate_limits)").all().map(({ name }) => name);
  assert.ok(supportRateLimitIndexes.includes("support_write_rate_limits_bucket_unique"));
  assert.ok(supportRateLimitIndexes.includes("support_write_rate_limits_window_idx"));
  const supportAdminPlan = database.prepare(`
    EXPLAIN QUERY PLAN SELECT id FROM support_inquiries
    WHERE kind=? AND status != 'deleted'
    ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,staff_unread DESC,updated_at DESC,id DESC
    LIMIT ? OFFSET ?
  `).all("support", 30, 0).map(({ detail }) => String(detail));
  assert.ok(supportAdminPlan.some((detail) => detail.includes("support_inquiries_admin_priority_idx")));
  assert.ok(!supportAdminPlan.some((detail) => detail.includes("TEMP B-TREE")));
  const supportMemberPlan = database.prepare(`
    EXPLAIN QUERY PLAN SELECT id FROM support_inquiries
    WHERE user_id=? AND kind=? AND status != 'deleted'
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(1, "support", 20, 0).map(({ detail }) => String(detail));
  assert.ok(supportMemberPlan.some((detail) => detail.includes("support_inquiries_member_kind_id_idx")));
  const postColumns = database.prepare("PRAGMA table_info(posts)").all().map(({ name }) => name);
  assert.ok(postColumns.includes("is_pinned"));
  assert.ok(postColumns.includes("community_tag_mask"));
  assert.ok(postColumns.includes("title_color"));
  assert.ok(postColumns.includes("author_name"));
  assert.ok(postColumns.includes("deleted_at"));
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
  for (const indexName of ["posts_category_status_created_idx", "posts_author_status_idx", "posts_event_activity_idx", "posts_draft_created_id_idx", "posts_deleted_retention_idx"]) assert.ok(postIndexes.includes(indexName));
  const userColumns = database.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
  assert.ok(userColumns.includes("is_director"));
  assert.ok(userColumns.includes("is_partner"));
  assert.ok(userColumns.includes("level_locked"));
  const userIndexes = database.prepare("PRAGMA index_list(users)").all().map(({ name }) => name);
  for (const indexName of ["users_created_id_idx", "users_points_id_idx", "users_level_id_idx", "users_username_nocase_id_idx", "users_nickname_nocase_id_idx", "users_director_created_id_idx", "users_partner_created_id_idx"]) assert.ok(userIndexes.includes(indexName));
  const shopProductColumns = database.prepare("PRAGMA table_info(shop_products)").all().map(({ name }) => name);
  assert.ok(shopProductColumns.includes("min_level"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_products WHERE min_level=1").get().count, 10);
  const eventRewardColumns = database.prepare("PRAGMA table_info(event_reward_payouts)").all().map(({ name }) => name);
  assert.ok(eventRewardColumns.includes("nickname_snapshot"));
  assert.ok(eventRewardColumns.includes("level_snapshot"));
  const eventRewardIndexes = database.prepare("PRAGMA index_list(event_reward_payouts)").all().map(({ name }) => name);
  for (const indexName of ["event_reward_payouts_period_user_unique", "event_reward_payouts_period_rank_unique", "event_reward_payouts_period_rank_idx", "event_reward_payouts_audit_idx"]) assert.ok(eventRewardIndexes.includes(indexName));
  const pointLedgerIndexes = database.prepare("PRAGMA index_list(point_ledger)").all().map(({ name }) => name);
  assert.ok(pointLedgerIndexes.includes("point_ledger_event_reward_user_reference_unique"));
  assert.ok(pointLedgerIndexes.includes("point_ledger_attendance_streak_user_reference_idx"));
  assert.ok(pointLedgerIndexes.includes("point_ledger_user_id_idx"));
  assert.ok(pointLedgerIndexes.includes("point_ledger_content_reward_user_reference_unique"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE type='post_create' AND reference='community:777'").get().count, 1);
  assert.equal(database.prepare("SELECT points FROM users WHERE username='duplicate-content'").get().points, 10);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE type='content_reward_correction' AND amount=-10").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE type='content_reward_duplicate' AND amount=10").get().count, 1);
  assert.equal(
    database.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total FROM point_ledger
      WHERE user_id=(SELECT id FROM users WHERE username='duplicate-content')
    `).get().total,
    10,
    "content reward dedupe keeps the auditable ledger sum aligned with the corrected balance",
  );
  const postCommentIndexes = database.prepare("PRAGMA index_list(post_comments)").all().map(({ name }) => name);
  for (const indexName of ["post_comments_user_status_idx", "post_comments_event_activity_idx", "post_comments_post_status_id_idx", "post_comments_pending_created_id_idx"]) assert.ok(postCommentIndexes.includes(indexName));
  const attendanceIndexes = database.prepare("PRAGMA index_list(attendance)").all().map(({ name }) => name);
  assert.ok(attendanceIndexes.includes("attendance_date_user_idx"));
  assert.ok(attendanceIndexes.includes("attendance_date_created_id_idx"));
  const eventActivityIndexes = database.prepare("PRAGMA index_list(event_activity_rollups)").all().map(({ name }) => name);
  for (const indexName of ["event_activity_rollups_period_user_unique", "event_activity_rollups_ranking_idx", "event_activity_rollups_period_discovery_idx"]) assert.ok(eventActivityIndexes.includes(indexName));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_rollup_cleanup_queue WHERE period_type='weekly' AND period_start='2026-07-05T15:00:00.000Z'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'event_activity_%'").get().count, 9);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'users_partner_requires_director_%'").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_settings WHERE key LIKE 'event_reward_catchup_watermark:%'").get().count, 2);
  assert.deepEqual(
    database.prepare(`
      SELECT period_type AS periodType,board_type AS boardType,activity_count AS activityCount
      FROM event_activity_rollups
      WHERE user_id=(SELECT id FROM users WHERE username='rollup-backfill')
      ORDER BY period_type,board_type
    `).all().map((row) => ({ ...row })),
    [
      { periodType: "monthly", boardType: "comments", activityCount: 2 },
      { periodType: "monthly", boardType: "posts", activityCount: 1 },
      { periodType: "weekly", boardType: "comments", activityCount: 2 },
      { periodType: "weekly", boardType: "posts", activityCount: 1 },
    ],
  );
  const repairedUser = database.prepare("SELECT id,points,is_director AS isDirector,is_partner AS isPartner FROM users WHERE username='rollup-backfill'").get();
  assert.deepEqual({ ...repairedUser }, { id: repairedUser.id, points: 16000, isDirector: 1, isPartner: 1 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM point_ledger
    WHERE user_id=? AND type='attendance_streak_reward'
  `).get(repairedUser.id).count, 2, "legacy streak ledger suppresses a duplicate while a missing ledger is repaired");
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM point_ledger
    WHERE user_id=? AND type='event_reward'
      AND reference='event:weekly:posts:2026-07-06:rank1'
  `).get(repairedUser.id).count, 1, "completed legacy payout receives its missing event ledger");
  const duplicateRankUser = database.prepare("SELECT id,points FROM users WHERE username='duplicate-rank'").get();
  assert.equal(duplicateRankUser.points, 0, "a later duplicate rank payout is fully reversed");
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM event_reward_payouts
    WHERE period_type='weekly' AND board_type='posts' AND period_start='2026-07-05T15:00:00.000Z' AND rank=1
  `).get().count, 1, "the first rank snapshot is the only authoritative payout");
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM point_ledger
    WHERE user_id=? AND type='event_reward_correction' AND amount=-10000
  `).get(duplicateRankUser.id).count, 1, "a duplicate paid snapshot keeps an auditable correction ledger");
  database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,is_director,is_partner,status,created_at)
    VALUES('partner-trigger','partner-trigger','hash','salt','192.0.2.41',0,1,'active','2026-07-22T03:00:00.000Z')
  `).run();
  assert.equal(database.prepare("SELECT is_director AS isDirector FROM users WHERE username='partner-trigger'").get().isDirector, 1);
  database.prepare("UPDATE users SET is_director=0 WHERE username='partner-trigger'").run();
  assert.equal(database.prepare("SELECT is_director AS isDirector FROM users WHERE username='partner-trigger'").get().isDirector, 1);

  assert.deepEqual(database.prepare("SELECT username FROM admin_owners ORDER BY username").all(), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM featured_vendor_posts").get().count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_products").get().count, 10);
  assert.deepEqual({ ...database.prepare("SELECT value,updated_by AS updatedBy FROM site_settings WHERE key='main_domain'").get() }, { value: "https://nara001.co.kr", updatedBy: "system" });
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'shop_purchase_%' ORDER BY name").all().map(({ name }) => name), ["shop_purchase_apply_after_insert", "shop_purchase_links_validate_before_update", "shop_purchase_validate_before_insert"]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('shop_voucher_purchase_validate_before_update','shop_voucher_state_validate_before_insert','shop_support_purchase_validate_before_insert','shop_support_purchase_validate_before_update') ORDER BY name").all().map(({ name }) => name), ["shop_support_purchase_validate_before_insert", "shop_support_purchase_validate_before_update", "shop_voucher_purchase_validate_before_update", "shop_voucher_state_validate_before_insert"]);
  assert.throws(() => database.prepare("DELETE FROM featured_vendor_posts WHERE slot=1").run(), /fixed_featured_vendor_post_cannot_be_deleted/);
  database.close();
});

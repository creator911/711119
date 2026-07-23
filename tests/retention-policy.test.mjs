import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openD1Database } from "../server/d1-sqlite.mjs";
import { applyMigrations } from "../server/migrate.mjs";
import { runRetentionMaintenance } from "../server/retention.mjs";

test("retention removes seven-day trash and thirty-day security rows without touching ledgers", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nara-retention-"));
  const database = openD1Database(path.join(directory, "fixture.sqlite"));
  const deletedObjects = [];
  const bucket = { delete: async (key) => { deletedObjects.push(key); } };
  try {
    applyMigrations(database);
    const now = new Date("2026-07-23T03:00:00.000Z");
    const old = "2026-06-01T00:00:00.000Z";
    const recent = "2026-07-22T00:00:00.000Z";
    await database.prepare(`
      INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,status,created_at)
      VALUES('retention-user','retention-user','hash','salt','192.0.2.90','active',?)
    `).bind(old).run();
    await database.prepare(`
      INSERT INTO posts(category,title,body,author_id,status,deleted_at,created_at)
      VALUES('community','old trash','body',1,'deleted',?,?),
            ('community','recent trash','body',1,'deleted',?,?),
            ('community','published','body',1,'published',NULL,?)
    `).bind(old, old, recent, old, old).run();
    await database.prepare(`
      INSERT INTO post_comments(post_id,user_id,body,status,created_at)
      VALUES(1,1,'old comment','published',?)
    `).bind(old).run();
    await database.prepare(`
      INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
      VALUES(1,10,'post_create','complete','retention-ledger',?)
    `).bind(old).run();
    await database.prepare(`
      INSERT INTO uploaded_media(key,owner_key,media_type,content_type,size_bytes,status,created_at)
      VALUES('old-media','member:1','image','image/jpeg',10,'pending',?),
            ('recent-media','member:1','image','image/jpeg',10,'pending',?)
    `).bind(old, recent).run();
    for (const table of [
      "admin_account_login_failures",
      "member_account_login_failures",
    ]) {
      await database.prepare(`
        INSERT INTO ${table}(username,failure_count,blocked_until,updated_at)
        VALUES('old-user',1,?,?),('recent-user',1,?,?)
      `).bind(old, old, recent, recent).run();
    }
    for (const table of [
      "admin_ip_login_failures",
      "member_ip_login_failures",
    ]) {
      await database.prepare(`
        INSERT INTO ${table}(ip,failure_count,blocked_until,updated_at)
        VALUES('192.0.2.1',1,?,?),('192.0.2.2',1,?,?)
      `).bind(old, old, recent, recent).run();
    }

    await runRetentionMaintenance(database, bucket, now);

    assert.deepEqual((await database.prepare("SELECT id FROM posts ORDER BY id").all()).results.map(({ id }) => id), [2, 3]);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM post_comments WHERE post_id=1").first("count"), 0);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM point_ledger").first("count"), 1);
    assert.deepEqual((await database.prepare("SELECT key FROM uploaded_media ORDER BY key").all()).results.map(({ key }) => key), ["recent-media"]);
    assert.deepEqual(deletedObjects, ["old-media"]);
    for (const table of [
      "admin_account_login_failures",
      "member_account_login_failures",
      "admin_ip_login_failures",
      "member_ip_login_failures",
    ]) {
      assert.equal(
        await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
        1,
        `${table} should retain only its recent row`,
      );
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

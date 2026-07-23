import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function migratedDatabase() {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/).map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
  return database;
}

const insertVoucher = (database, productId, suffix) => {
  database.prepare(`
    INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
    VALUES(?,?,?,?,10,'available',?)
  `).run(productId, `shop-private/00000000-0000-4000-8000-${suffix}.jpg`, `${suffix}.jpg`, "image/jpeg", new Date().toISOString());
  return Number(database.prepare("SELECT last_insert_rowid() AS id").get().id);
};

test("관리자 지급 이미지 삭제는 available·미지정 이미지만 원자적으로 정리 큐에 옮긴다", async () => {
  const database = await migratedDatabase();
  database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES('voucher-admin-test','지급검증','hash','salt','127.0.0.8',100000,1,0,0,'member','active',?)
  `).run(new Date().toISOString());
  const userId = Number(database.prepare("SELECT id FROM users WHERE username='voucher-admin-test'").get().id);
  const product = database.prepare("SELECT id,name,price FROM shop_products WHERE id=1").get();
  for (const requestKey of ["voucher-admin-request-0001", "voucher-admin-request-0002"]) {
    database.prepare(`
      INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
      VALUES(?,?,?,?,?,'pending_delivery',?)
    `).run(requestKey, product.id, userId, product.name, product.price, new Date().toISOString());
  }
  const purchases = database.prepare("SELECT id FROM shop_purchases WHERE user_id=? ORDER BY id").all(userId);
  const availableId = insertVoucher(database, product.id, "000000000101");
  const reservedId = insertVoucher(database, product.id, "000000000102");
  const deliveredId = insertVoucher(database, product.id, "000000000103");
  database.prepare("UPDATE shop_vouchers SET status='reserved',purchase_id=?,assigned_at=? WHERE id=?")
    .run(purchases[0].id, new Date().toISOString(), reservedId);
  database.prepare("UPDATE shop_vouchers SET status='delivered',purchase_id=?,assigned_at=? WHERE id=?")
    .run(purchases[1].id, new Date().toISOString(), deliveredId);

  const cleanupToken = "voucher-cleanup-selected";
  database.exec("BEGIN IMMEDIATE");
  database.prepare(`
    INSERT INTO shop_voucher_cleanup_queue(voucher_id,product_id,object_key,cleanup_token,created_at)
    SELECT id,product_id,object_key,?,?
    FROM shop_vouchers
    WHERE product_id=? AND status='available' AND purchase_id IS NULL AND id IN (?,?,?)
  `).run(cleanupToken, new Date().toISOString(), product.id, availableId, reservedId, deliveredId);
  database.prepare(`
    DELETE FROM shop_vouchers
    WHERE product_id=? AND status='available' AND purchase_id IS NULL
      AND id IN (SELECT voucher_id FROM shop_voucher_cleanup_queue WHERE cleanup_token=?)
  `).run(product.id, cleanupToken);
  database.exec("COMMIT");
  assert.deepEqual(
    database.prepare("SELECT voucher_id AS id FROM shop_voucher_cleanup_queue WHERE cleanup_token=?").all(cleanupToken).map((row) => Number(row.id)),
    [availableId],
  );
  assert.deepEqual(
    database.prepare("SELECT id,status,purchase_id AS purchaseId FROM shop_vouchers ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: reservedId, status: "reserved", purchaseId: purchases[0].id },
      { id: deliveredId, status: "delivered", purchaseId: purchases[1].id },
    ],
  );
  database.prepare("DELETE FROM shop_voucher_cleanup_queue WHERE voucher_id=?").run(availableId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_voucher_cleanup_queue").get().count, 0);
  database.close();
});

test("전부 지우기는 500개 배치로 반복해 대량 재고도 빠짐없이 처리한다", async () => {
  const database = await migratedDatabase();
  const productId = 1;
  database.exec("BEGIN");
  for (let index = 0; index < 505; index += 1) {
    insertVoucher(database, productId, String(200000 + index).padStart(12, "0"));
  }
  database.exec("COMMIT");
  let batchNumber = 0;
  const queueBatch = () => {
    const token = `cleanup-batch-${batchNumber += 1}`;
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      INSERT INTO shop_voucher_cleanup_queue(voucher_id,product_id,object_key,cleanup_token,created_at)
      SELECT id,product_id,object_key,?,?
      FROM shop_vouchers
      WHERE product_id=? AND status='available' AND purchase_id IS NULL
      ORDER BY id ASC LIMIT 500
    `).run(token, new Date().toISOString(), productId);
    database.prepare(`
      DELETE FROM shop_vouchers
      WHERE product_id=? AND status='available' AND purchase_id IS NULL
        AND id IN (SELECT voucher_id FROM shop_voucher_cleanup_queue WHERE cleanup_token=?)
    `).run(productId, token);
    database.exec("COMMIT");
    return Number(database.prepare("SELECT COUNT(*) AS count FROM shop_voucher_cleanup_queue WHERE cleanup_token=?").get(token).count);
  };

  assert.equal(queueBatch(), 500);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_vouchers WHERE product_id=? AND status='available'").get(productId).count, 5);
  assert.equal(queueBatch(), 5);
  assert.equal(queueBatch(), 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_voucher_cleanup_queue WHERE product_id=?").get(productId).count, 505);
  database.prepare("DELETE FROM shop_voucher_cleanup_queue WHERE product_id=?").run(productId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_vouchers WHERE product_id=?").get(productId).count, 0);
  database.close();
});

test("저장소 정리 재시도는 실패 횟수가 적은 항목부터 순환해 뒤 항목을 막지 않는다", async () => {
  const database = await migratedDatabase();
  const insert = database.prepare(`
    INSERT INTO shop_voucher_cleanup_queue(voucher_id,product_id,object_key,cleanup_token,attempts,created_at)
    VALUES(1000000 + ?,1,?,?,0,?)
  `);
  const createdAt = new Date().toISOString();
  database.exec("BEGIN");
  for (let index = 1; index <= 205; index += 1) {
    insert.run(index, `shop-private/cleanup-${index}.jpg`, `retry-${index}`, createdAt);
  }
  database.exec("COMMIT");

  const retryBatch = () => {
    const rows = database.prepare(`
      SELECT voucher_id AS id
      FROM shop_voucher_cleanup_queue
      WHERE product_id=?
      ORDER BY attempts ASC,voucher_id ASC LIMIT 100
    `).all(1);
    const ids = rows.map((row) => Number(row.id));
    const placeholders = ids.map(() => "?").join(",");
    database.prepare(`UPDATE shop_voucher_cleanup_queue SET attempts=attempts+1 WHERE voucher_id IN (${placeholders})`).run(...ids);
    return ids;
  };

  retryBatch();
  retryBatch();
  const thirdBatch = retryBatch();
  assert.deepEqual(thirdBatch.slice(0, 5), [1000201, 1000202, 1000203, 1000204, 1000205]);
  assert.equal(database.prepare("SELECT MIN(attempts) AS attempts FROM shop_voucher_cleanup_queue").get().attempts, 1);
  database.close();
});

test("관리자 지급 이미지 API와 반응형 UI가 삭제 안전장치를 유지한다", async () => {
  const [route, component, styles] = await Promise.all([
    readFile(new URL("../app/api/admin/shop/[id]/vouchers/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminShop.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /adminSession\(request, env\)/);
  assert.match(route, /status='available' AND purchase_id IS NULL/);
  assert.match(route, /INSERT OR IGNORE INTO shop_voucher_cleanup_queue/);
  assert.match(route, /DELETE FROM shop_voucher_cleanup_queue/);
  assert.match(route, /retryPendingVoucherCleanup/);
  assert.match(route, /SELECT voucher_id AS id,object_key AS objectKey/);
  assert.match(route, /ORDER BY attempts ASC,voucher_id ASC LIMIT/);
  assert.match(route, /try \{\s*body = await request\.json\(\);\s*\} catch/);
  assert.match(component, /기존 이미지 펼쳐보기/);
  assert.match(component, /선택 삭제/);
  assert.match(component, /전부 지우기/);
  assert.match(route, /const SELECTED_DELETE_LIMIT = 80/);
  assert.match(component, /Math\.ceil\(ids\.length \/ 80\)/);
  assert.match(component, /result\.hasMore !== true/);
  assert.match(component, /applyProduct\(product\)/);
  assert.match(component, /refreshProduct\(productId\)/);
  assert.match(component, /현황 확인 필요/);
  assert.match(styles, /\.shop-voucher-thumbnails \{[^}]*grid-template-columns:repeat\(4/);
  assert.match(styles, /@media\(max-width:600px\)[\s\S]*\.shop-voucher-thumbnails \{ grid-template-columns:repeat\(3/);
});

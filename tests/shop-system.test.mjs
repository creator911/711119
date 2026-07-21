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

test("상점 구매는 포인트·재고·장부·고객센터를 한 번만 원자 처리한다", async () => {
  const database = await migratedDatabase();
  database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,1000,1,0,0,'member','active',?)
  `).run("shopbuyer", "상점구매자", "hash", "salt", "127.0.0.1", new Date().toISOString());
  const userId = Number(database.prepare("SELECT id FROM users WHERE username='shopbuyer'").get().id);
  const product = database.prepare("SELECT id,name,price,stock FROM shop_products WHERE id=1").get();
  const requestKey = "shop-test-request-001";

  database.prepare(`
    INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
    VALUES(?,?,?,?,?,'pending_delivery',?)
  `).run(requestKey, product.id, userId, product.name, product.price, new Date().toISOString());

  assert.equal(database.prepare("SELECT points FROM users WHERE id=?").get(userId).points, 900);
  assert.equal(database.prepare("SELECT stock FROM shop_products WHERE id=?").get(product.id).stock, product.stock - 1);
  assert.deepEqual({ ...database.prepare("SELECT amount,type,status FROM point_ledger WHERE user_id=?").get(userId) }, { amount: -100, type: "shop_purchase", status: "complete" });
  const purchase = database.prepare("SELECT id,support_inquiry_id AS supportInquiryId FROM shop_purchases WHERE user_id=?").get(userId);
  assert.ok(purchase.supportInquiryId > 0);
  assert.deepEqual({ ...database.prepare("SELECT user_id AS userId,kind,shop_purchase_id AS shopPurchaseId FROM support_inquiries WHERE id=?").get(purchase.supportInquiryId) }, { userId, kind: "support", shopPurchaseId: purchase.id });

  database.prepare(`
    INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
    VALUES(?,'shop-private/00000000-0000-4000-8000-000000000000.jpg','voucher.jpg','image/jpeg',10,'available',?)
  `).run(product.id, new Date().toISOString());
  const voucherId = Number(database.prepare("SELECT id FROM shop_vouchers WHERE product_id=?").get(product.id).id);
  const deliveredAt = new Date().toISOString();
  database.prepare("UPDATE shop_vouchers SET status='reserved',purchase_id=?,assigned_at=? WHERE id=?").run(purchase.id, deliveredAt, voucherId);
  database.prepare("UPDATE support_inquiries SET title='상품 구매 상품이 도착했습니다.',status='answered',updated_at=? WHERE id=?").run(deliveredAt, purchase.supportInquiryId);
  database.prepare("UPDATE shop_purchases SET status='delivered',voucher_id=?,delivered_at=? WHERE id=?").run(voucherId, deliveredAt, purchase.id);
  database.prepare("UPDATE shop_vouchers SET status='delivered' WHERE id=?").run(voucherId);
  assert.deepEqual({ ...database.prepare("SELECT status,voucher_id AS voucherId FROM shop_purchases WHERE id=?").get(purchase.id) }, { status: "delivered", voucherId });

  assert.throws(() => database.prepare(`
    INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
    VALUES(?,?,?,?,?,'pending_delivery',?)
  `).run(requestKey, product.id, userId, product.name, product.price, new Date().toISOString()), /UNIQUE/);
  assert.equal(database.prepare("SELECT points FROM users WHERE id=?").get(userId).points, 900);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE user_id=? AND type='shop_purchase'").get(userId).count, 1);
  database.close();
});

test("포인트 부족과 품절 구매는 어떤 데이터도 변경하지 않는다", async () => {
  const database = await migratedDatabase();
  database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,50,1,0,0,'member','active',?)
  `).run("shopblocked", "구매차단", "hash", "salt", "127.0.0.2", new Date().toISOString());
  const userId = Number(database.prepare("SELECT id FROM users WHERE username='shopblocked'").get().id);
  const product = database.prepare("SELECT id,name,price,stock FROM shop_products WHERE id=1").get();
  assert.throws(() => database.prepare(`
    INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
    VALUES('shop-test-request-002',?,?,?,?,'pending_delivery',?)
  `).run(product.id, userId, product.name, product.price, new Date().toISOString()), /shop_points_insufficient/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_purchases WHERE user_id=?").get(userId).count, 0);
  assert.equal(database.prepare("SELECT points FROM users WHERE id=?").get(userId).points, 50);
  assert.equal(database.prepare("SELECT stock FROM shop_products WHERE id=?").get(product.id).stock, product.stock);

  database.prepare("UPDATE users SET points=1000 WHERE id=?").run(userId);
  database.prepare("UPDATE shop_products SET stock=0 WHERE id=?").run(product.id);
  assert.throws(() => database.prepare(`
    INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
    VALUES('shop-test-request-003',?,?,?,?,'pending_delivery',?)
  `).run(product.id, userId, product.name, product.price, new Date().toISOString()), /shop_stock_insufficient/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shop_purchases WHERE user_id=?").get(userId).count, 0);
  assert.equal(database.prepare("SELECT points FROM users WHERE id=?").get(userId).points, 1000);
  database.close();
});

test("지급 이미지는 공개 미디어 경로가 아닌 권한 확인 전용 경로를 사용한다", async () => {
  const [deliverySource, richTextSource, shopPageSource, purchaseSource, adminProductSource, adminOverviewSource] = await Promise.all([
    readFile(new URL("../app/api/shop/vouchers/[id]/image/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/rich-text.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ShopPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shop/purchase/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/shop/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/overview/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(deliverySource, /memberFromSession/);
  assert.match(deliverySource, /adminSession/);
  assert.match(deliverySource, /private, no-store/);
  assert.match(deliverySource, /p\.voucher_id=v\.id/);
  assert.match(deliverySource, /p\.status='delivered'/);
  assert.match(richTextSource, /api\\\/shop\\\/vouchers/);
  assert.match(shopPageSource, /product\.stock > 0/);
  assert.doesNotMatch(shopPageSource, /availableVouchers > 0/);
  assert.match(purchaseSource, /const duplicate = await purchaseByRequest[\s\S]*duplicate\.productId !== productId/);
  assert.doesNotMatch(purchaseSource, /inserted\.meta\.changes/);
  assert.match(adminProductSource, /expectedStock/);
  assert.match(adminProductSource, /WHERE id=\? AND version=\? AND stock=\?/);
  assert.doesNotMatch(adminOverviewSource, /p\.stock<=5 OR/);
});

test("상품권·구매·고객센터 연결은 서로 다른 상품이나 회원으로 엮을 수 없다", async () => {
  const database = await migratedDatabase();
  database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,1000,1,0,0,'member','active',?)
  `).run("shoplinks", "연결검증", "hash", "salt", "127.0.0.3", new Date().toISOString());
  const userId = Number(database.prepare("SELECT id FROM users WHERE username='shoplinks'").get().id);
  const first = database.prepare("SELECT id,name,price FROM shop_products WHERE id=1").get();
  const second = database.prepare("SELECT id FROM shop_products WHERE id=2").get();
  database.prepare(`
    INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
    VALUES('shop-link-request-001',?,?,?,?,'pending_delivery',?)
  `).run(first.id, userId, first.name, first.price, new Date().toISOString());
  const purchaseId = Number(database.prepare("SELECT id FROM shop_purchases WHERE user_id=?").get(userId).id);
  database.prepare(`
    INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
    VALUES(2,'shop-private/00000000-0000-4000-8000-000000000001.jpg','wrong.jpg','image/jpeg',10,'available',?)
  `).run(new Date().toISOString());
  const voucherId = Number(database.prepare("SELECT id FROM shop_vouchers WHERE product_id=?").get(second.id).id);
  assert.throws(
    () => database.prepare("UPDATE shop_vouchers SET purchase_id=?,status='reserved' WHERE id=?").run(purchaseId, voucherId),
    /shop_voucher_purchase_invalid/,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO support_inquiries(user_id,kind,title,body,status,staff_unread,member_unread,shop_purchase_id,created_at,updated_at)
      VALUES(999999,'support','잘못된 연결','본문','open',0,0,?,?,?)
    `).run(purchaseId, new Date().toISOString(), new Date().toISOString()),
    /shop_support_purchase_invalid/,
  );
  database.prepare(`
    INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
    VALUES(1,'shop-private/00000000-0000-4000-8000-000000000002.jpg','right.jpg','image/jpeg',10,'available',?)
  `).run(new Date().toISOString());
  const assignedVoucherId = Number(database.prepare("SELECT id FROM shop_vouchers WHERE product_id=1").get().id);
  database.prepare("UPDATE shop_vouchers SET purchase_id=?,status='reserved' WHERE id=?").run(purchaseId, assignedVoucherId);
  assert.throws(
    () => database.prepare("UPDATE shop_vouchers SET product_id=2 WHERE id=?").run(assignedVoucherId),
    /shop_voucher_purchase_invalid/,
  );
  const supportInquiryId = Number(database.prepare("SELECT support_inquiry_id AS id FROM shop_purchases WHERE id=?").get(purchaseId).id);
  assert.throws(
    () => database.prepare("UPDATE support_inquiries SET user_id=999999 WHERE id=?").run(supportInquiryId),
    /shop_support_purchase_invalid/,
  );
  database.close();
});

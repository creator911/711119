export type ShopProductRow = {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  fallbackImage: string;
  coverKey: string | null;
  status: "active" | "hidden";
  version: number;
  availableVouchers: number;
  pendingPurchases: number;
  deliveredPurchases: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicShopProduct = {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  imageUrl: string;
  availableVouchers: number;
  active: boolean;
  version: number;
};

type ShopDatabase = Pick<D1Database, "prepare" | "batch">;

const productSelect = `
  SELECT p.id,p.name,p.description,p.price,p.stock,p.fallback_image AS fallbackImage,
         p.cover_key AS coverKey,p.status,p.version,p.created_at AS createdAt,p.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM shop_vouchers v WHERE v.product_id=p.id AND v.status='available') AS availableVouchers,
         (SELECT COUNT(*) FROM shop_purchases o WHERE o.product_id=p.id AND o.status='pending_delivery') AS pendingPurchases,
         (SELECT COUNT(*) FROM shop_purchases o WHERE o.product_id=p.id AND o.status='delivered') AS deliveredPurchases
  FROM shop_products p
`;

export async function shopProducts(database: ShopDatabase, includeHidden = false) {
  const result = await database.prepare(`${productSelect}${includeHidden ? "" : " WHERE p.status='active'"} ORDER BY p.id ASC`)
    .all<ShopProductRow>();
  return result.results;
}

export async function shopProduct(database: ShopDatabase, id: number, includeHidden = false) {
  return database.prepare(`${productSelect} WHERE p.id=?${includeHidden ? "" : " AND p.status='active'"}`)
    .bind(id).first<ShopProductRow>();
}

export function publicShopProduct(row: ShopProductRow): PublicShopProduct {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    price: Number(row.price),
    stock: Number(row.stock),
    imageUrl: row.coverKey ? `/api/shop/products/${row.id}/image?v=${row.version}` : row.fallbackImage,
    availableVouchers: Number(row.availableVouchers),
    active: row.status === "active",
    version: Number(row.version),
  };
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

type PendingPurchase = { id: number; productName: string };
type VoucherRow = { id: number; purchaseId: number; objectKey: string };

export async function deliverPendingShopPurchases(database: ShopDatabase, productId: number, limit = 50) {
  const delivered: number[] = [];
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

  for (let index = 0; index < boundedLimit; index += 1) {
    const purchase = await database.prepare(`
      SELECT id,product_name AS productName
      FROM shop_purchases
      WHERE product_id=? AND status='pending_delivery'
      ORDER BY id ASC LIMIT 1
    `).bind(productId).first<PendingPurchase>();
    if (!purchase) break;

    let voucher = await database.prepare(`
      SELECT id,purchase_id AS purchaseId,object_key AS objectKey
      FROM shop_vouchers WHERE purchase_id=? AND status='reserved'
    `).bind(purchase.id).first<VoucherRow>();

    if (!voucher) {
      voucher = await database.prepare(`
        UPDATE shop_vouchers
        SET status='reserved',purchase_id=?,assigned_at=?
        WHERE id=(
          SELECT id FROM shop_vouchers
          WHERE product_id=? AND status='available'
          ORDER BY id ASC LIMIT 1
        ) AND status='available'
          AND NOT EXISTS(
            SELECT 1 FROM shop_vouchers
            WHERE purchase_id=? AND status IN ('reserved','delivered')
          )
        RETURNING id,purchase_id AS purchaseId,object_key AS objectKey
      `).bind(purchase.id, new Date().toISOString(), productId, purchase.id).first<VoucherRow>();
      if (!voucher) {
        voucher = await database.prepare(`
          SELECT id,purchase_id AS purchaseId,object_key AS objectKey
          FROM shop_vouchers WHERE purchase_id=? AND status='reserved'
        `).bind(purchase.id).first<VoucherRow>();
      }
    }
    if (!voucher) break;

    const deliveredAt = new Date().toISOString();
    const body = `<p><strong>상품이 도착했습니다.</strong></p><p>${escapeHtml(purchase.productName)}</p><p>아래 상품 이미지를 저장해 사용해 주세요.</p><img src="/api/shop/vouchers/${voucher.id}/image" />`;
    const results = await database.batch([
      database.prepare(`
        UPDATE support_inquiries
        SET title='상품 구매 상품이 도착했습니다.',body=?,status='answered',member_unread=member_unread+1,updated_at=?
        WHERE shop_purchase_id=?
          AND EXISTS(SELECT 1 FROM shop_purchases WHERE id=? AND status='pending_delivery')
      `).bind(body, deliveredAt, purchase.id, purchase.id),
      database.prepare(`
        UPDATE shop_purchases
        SET status='delivered',voucher_id=?,delivered_at=?
        WHERE id=? AND status='pending_delivery'
          AND EXISTS(SELECT 1 FROM support_inquiries WHERE shop_purchase_id=? AND body=?)
      `).bind(voucher.id, deliveredAt, purchase.id, purchase.id, body),
      database.prepare(`
        UPDATE shop_vouchers SET status='delivered'
        WHERE id=? AND purchase_id=?
          AND EXISTS(SELECT 1 FROM shop_purchases WHERE id=? AND voucher_id=? AND status='delivered')
      `).bind(voucher.id, purchase.id, purchase.id, voucher.id),
    ]);
    if (results[1]?.meta.changes !== 1) break;
    delivered.push(purchase.id);
  }

  return delivered;
}

export function shopErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("shop_points_insufficient")) return { status: 409, message: "보유 포인트가 부족합니다." };
  if (message.includes("shop_stock_insufficient")) return { status: 409, message: "품절된 상품입니다." };
  if (message.includes("shop_product_unavailable") || message.includes("shop_product_changed")) return { status: 409, message: "상품 정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요." };
  if (message.includes("shop_member_unavailable")) return { status: 403, message: "현재 계정으로 상품을 구매할 수 없습니다." };
  if (message.includes("shop_request_invalid")) return { status: 400, message: "구매 요청 정보를 확인해 주세요." };
  return null;
}

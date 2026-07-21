import { env } from "cloudflare:workers";
import { adminSession } from "../../../../../lib/admin-auth";
import { deliverPendingShopPurchases, publicShopProduct, shopProduct } from "../../../../../lib/shop";

type MediaBucket = {
  put: (key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => Promise<unknown>;
  delete: (key: string | string[]) => Promise<unknown>;
};

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const FILE_LIMIT = 5 * 1024 * 1024;
const TOTAL_LIMIT = 100 * 1024 * 1024;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const productId = Number((await context.params).id);
  if (!Number.isInteger(productId) || productId < 1) return Response.json({ error: "상품 번호를 확인해 주세요." }, { status: 400 });
  if (!await shopProduct(env.DB, productId, true)) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });

  const form = await request.formData();
  const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
  if (!files.length || files.length > 30) return Response.json({ error: "지급 이미지는 한 번에 1~30개까지 추가할 수 있습니다." }, { status: 400 });
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > TOTAL_LIMIT) return Response.json({ error: "한 번에 추가하는 이미지의 전체 용량은 100MB 이하여야 합니다." }, { status: 413 });
  for (const file of files) {
    if (!IMAGE_TYPES[file.type]) return Response.json({ error: "JPG, PNG, GIF, WebP 이미지만 지급 이미지로 사용할 수 있습니다." }, { status: 415 });
    if (file.size > FILE_LIMIT) return Response.json({ error: "지급 이미지는 한 장당 5MB 이하여야 합니다." }, { status: 413 });
  }

  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });
  const uploaded: Array<{ key: string; file: File }> = [];
  let voucherRowsCreated = false;
  try {
    for (const file of files) {
      const key = `shop-private/${crypto.randomUUID()}.${IMAGE_TYPES[file.type]}`;
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { uploader: operator.username, purpose: `shop-voucher:${productId}`, originalName: file.name.slice(0, 160) },
      });
      uploaded.push({ key, file });
    }
    const createdAt = new Date().toISOString();
    await env.DB.batch(uploaded.map(({ key, file }) => env.DB.prepare(`
      INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
      VALUES(?,?,?,?,?,'available',?)
    `).bind(productId, key, file.name.slice(0, 160), file.type, file.size, createdAt)));
    voucherRowsCreated = true;
    const delivered = await deliverPendingShopPurchases(env.DB, productId, uploaded.length).catch((error) => {
      console.error("Automatic shop delivery failed after voucher registration", error);
      return [];
    });
    const saved = await shopProduct(env.DB, productId, true);
    if (!saved) throw new Error("Saved shop product is unavailable");
    return Response.json({
      uploaded: uploaded.length,
      delivered: delivered.length,
      product: {
        ...publicShopProduct(saved),
        active: saved.status === "active",
        pendingPurchases: Number(saved.pendingPurchases),
        deliveredPurchases: Number(saved.deliveredPurchases),
      },
    }, { status: 201 });
  } catch (error) {
    if (!voucherRowsCreated && uploaded.length) {
      await bucket.delete(uploaded.map((item) => item.key)).catch(() => Promise.all(uploaded.map((item) => bucket.delete(item.key).catch(() => undefined))));
    }
    console.error("Admin shop voucher upload failed", error);
    return Response.json({ error: "자동상품 지급 이미지를 저장하지 못했습니다." }, { status: 500 });
  }
}

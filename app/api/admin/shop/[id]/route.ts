import { env } from "cloudflare:workers";
import { adminSession } from "../../../../lib/admin-auth";
import { publicShopProduct, shopProduct } from "../../../../lib/shop";

type MediaBucket = {
  put: (key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const IMAGE_LIMIT = 8 * 1024 * 1024;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const productId = Number((await context.params).id);
  if (!Number.isInteger(productId) || productId < 1) return Response.json({ error: "상품 번호를 확인해 주세요." }, { status: 400 });

  const current = await shopProduct(env.DB, productId, true);
  if (!current) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });

  let uploadedKey = "";
  let bucket: MediaBucket | null = null;
  let productUpdated = false;
  try {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
    const description = String(form.get("description") ?? "").trim().replace(/\s+/g, " ");
    const price = Number(form.get("price"));
    const stock = Number(form.get("stock"));
    const status = form.get("active") === "true" ? "active" : "hidden";
    const version = Number(form.get("version"));
    const expectedStock = Number(form.get("expectedStock"));
    if (name.length < 2 || name.length > 60) return Response.json({ error: "상품명은 2~60자로 입력해 주세요." }, { status: 400 });
    if (description.length > 160) return Response.json({ error: "상품 설명은 160자 이하로 입력해 주세요." }, { status: 400 });
    if (!Number.isInteger(price) || price < 1 || price > 100_000_000) return Response.json({ error: "가격은 1P 이상으로 입력해 주세요." }, { status: 400 });
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) return Response.json({ error: "판매 수량은 0개 이상으로 입력해 주세요." }, { status: 400 });
    if (!Number.isInteger(version) || version < 1) return Response.json({ error: "상품 버전을 확인해 주세요." }, { status: 400 });
    if (!Number.isInteger(expectedStock) || expectedStock < 0) return Response.json({ error: "현재 판매 수량을 확인해 주세요." }, { status: 400 });

    let nextCoverKey = current.coverKey;
    const cover = form.get("cover");
    if (cover !== null && !(cover instanceof File)) return Response.json({ error: "상품 사진을 확인해 주세요." }, { status: 400 });
    if (cover instanceof File && cover.size) {
      const extension = IMAGE_TYPES[cover.type];
      if (!extension) return Response.json({ error: "JPG, PNG, GIF, WebP 이미지만 사용할 수 있습니다." }, { status: 415 });
      if (cover.size > IMAGE_LIMIT) return Response.json({ error: "상품 사진은 8MB 이하여야 합니다." }, { status: 413 });
      bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
      if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });
      uploadedKey = `shop-product/${crypto.randomUUID()}.${extension}`;
      await bucket.put(uploadedKey, await cover.arrayBuffer(), {
        httpMetadata: { contentType: cover.type },
        customMetadata: { uploader: operator.username, purpose: `shop-product:${productId}`, originalName: cover.name.slice(0, 160) },
      });
      nextCoverKey = uploadedKey;
    }

    const updatedAt = new Date().toISOString();
    const updated = await env.DB.prepare(`
      UPDATE shop_products
      SET name=?,description=?,price=?,stock=?,status=?,cover_key=?,version=version+1,updated_at=?
      WHERE id=? AND version=? AND stock=?
    `).bind(name, description, price, stock, status, nextCoverKey, updatedAt, productId, version, expectedStock).run();
    if (updated.meta.changes !== 1) {
      if (uploadedKey && bucket) await bucket.delete(uploadedKey).catch(() => undefined);
      return Response.json({ error: "구매 또는 다른 관리자 수정으로 상품 정보가 변경되었습니다. 상품을 다시 불러와 주세요." }, { status: 409 });
    }
    productUpdated = true;
    if (uploadedKey && current.coverKey && current.coverKey !== uploadedKey && bucket) {
      await bucket.delete(current.coverKey).catch(() => undefined);
    }
    const saved = await shopProduct(env.DB, productId, true);
    if (!saved) throw new Error("Saved shop product is unavailable");
    return Response.json({ product: {
      ...publicShopProduct(saved),
      active: saved.status === "active",
      pendingPurchases: Number(saved.pendingPurchases),
      deliveredPurchases: Number(saved.deliveredPurchases),
    } });
  } catch (error) {
    if (!productUpdated && uploadedKey && bucket) await bucket.delete(uploadedKey).catch(() => undefined);
    console.error("Admin shop product update failed", error);
    return Response.json({ error: "상품 정보를 저장하지 못했습니다." }, { status: 500 });
  }
}

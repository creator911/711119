import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../lib/member-auth";
import { deliverPendingShopPurchases, publicShopProduct, shopErrorResponse, shopProduct } from "../../../lib/shop";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../lib/distributed-rate-limit";

type PurchaseRow = {
  id: number;
  productId: number;
  status: "pending_delivery" | "delivered";
  price: number;
};

async function purchaseByRequest(userId: number, requestKey: string) {
  return env.DB.prepare(`
    SELECT id,product_id AS productId,status,price
    FROM shop_purchases WHERE user_id=? AND request_key=?
  `).bind(userId, requestKey).first<PurchaseRow>();
}

async function responseFor(userId: number, purchase: PurchaseRow) {
  await deliverPendingShopPurchases(env.DB, purchase.productId).catch((error) => console.error("Shop delivery retry failed", error));
  const [savedPurchase, product, user] = await Promise.all([
    env.DB.prepare("SELECT id,product_id AS productId,status,price FROM shop_purchases WHERE id=? AND user_id=?")
      .bind(purchase.id, userId).first<PurchaseRow>(),
    shopProduct(env.DB, purchase.productId, true),
    env.DB.prepare("SELECT points FROM users WHERE id=?").bind(userId).first<{ points: number }>(),
  ]);
  if (!savedPurchase || !product || !user) throw new Error("Saved shop purchase is unavailable");
  return Response.json({
    purchase: { id: savedPurchase.id, delivered: savedPurchase.status === "delivered" },
    product: publicShopProduct(product),
    points: user.points,
  });
}

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 상품을 구매할 수 있습니다." }, { status: 401 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "shop-purchase", String(user.id), 30, 60);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);

  let productId = 0;
  let requestKey = "";
  try {
    const payload = await request.json() as { productId?: unknown; requestKey?: unknown };
    productId = Number(payload.productId);
    requestKey = typeof payload.requestKey === "string" ? payload.requestKey.trim() : "";
  } catch {
    return Response.json({ error: "구매 요청 정보를 확인해 주세요." }, { status: 400 });
  }
  if (!Number.isInteger(productId) || productId < 1 || !/^[A-Za-z0-9_-]{12,80}$/.test(requestKey)) {
    return Response.json({ error: "구매 요청 정보를 확인해 주세요." }, { status: 400 });
  }

  const existing = await purchaseByRequest(user.id, requestKey);
  if (existing) {
    if (existing.productId !== productId) return Response.json({ error: "이미 다른 상품 구매에 사용된 요청입니다. 다시 시도해 주세요." }, { status: 409 });
    return responseFor(user.id, existing);
  }

  try {
    const createdAt = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO shop_purchases(request_key,product_id,user_id,product_name,price,status,created_at)
      SELECT ?,p.id,?,p.name,p.price,'pending_delivery',?
      FROM shop_products p WHERE p.id=?
    `).bind(requestKey, user.id, createdAt, productId).run();
    const purchase = await purchaseByRequest(user.id, requestKey);
    if (!purchase) return Response.json({ error: "판매 중인 상품을 찾을 수 없습니다." }, { status: 404 });
    return responseFor(user.id, purchase);
  } catch (error) {
    const duplicate = await purchaseByRequest(user.id, requestKey).catch(() => null);
    if (duplicate) {
      if (duplicate.productId !== productId) return Response.json({ error: "이미 다른 상품 구매에 사용된 요청입니다. 다시 시도해 주세요." }, { status: 409 });
      return responseFor(user.id, duplicate);
    }
    const shopError = shopErrorResponse(error);
    if (shopError) return Response.json({ error: shopError.message }, { status: shopError.status });
    console.error("Shop purchase failed", error);
    return Response.json({ error: "상품 구매를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}

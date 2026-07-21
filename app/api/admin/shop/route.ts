import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { publicShopProduct, shopProducts } from "../../../lib/shop";

export async function GET(request: Request) {
  if (!await adminSession(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const products = await shopProducts(env.DB, true);
    const adminProducts = products.map((product) => ({
      ...publicShopProduct(product),
      active: product.status === "active",
      pendingPurchases: Number(product.pendingPurchases),
      deliveredPurchases: Number(product.deliveredPurchases),
    }));
    const lowStockCount = adminProducts.filter((product) => product.active && product.availableVouchers <= 5).length;
    return Response.json({ products: adminProducts, lowStockCount }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Admin shop load failed", error);
    return Response.json({ error: "상점 상품을 불러오지 못했습니다." }, { status: 500 });
  }
}

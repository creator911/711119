import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { publicShopProduct, shopProducts } from "../../lib/shop";

export async function GET(request: Request) {
  try {
    const [products, user] = await Promise.all([
      shopProducts(env.DB),
      memberFromSession(request).catch(() => null),
    ]);
    return Response.json({
      products: products.map(publicShopProduct),
      user: user ? { points: user.points } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Shop load failed", error);
    return Response.json({ error: "상점 상품을 불러오지 못했습니다." }, { status: 500 });
  }
}

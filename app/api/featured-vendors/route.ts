import { env } from "cloudflare:workers";
import { featuredVendorAccess } from "../../lib/featured-vendor-auth";
import { publicFeaturedVendor, type FeaturedVendorRow } from "../../lib/featured-vendors";

export async function GET(request: Request) {
  try {
    const [rows, access] = await Promise.all([
      env.DB.prepare(`
        SELECT slot,industry,region,district,title,body,cover_key AS coverKey,version,
               created_at AS createdAt,updated_at AS updatedAt
        FROM featured_vendor_posts
        ORDER BY slot
      `).all<FeaturedVendorRow>(),
      featuredVendorAccess(request),
    ]);
    const editable = new Set(access.editableSlots);
    return Response.json({ posts: rows.results.map((row) => publicFeaturedVendor(row, editable.has(row.slot))) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Featured vendors load failed", error);
    return Response.json({ error: "추천 업체를 불러오지 못했습니다." }, { status: 500 });
  }
}

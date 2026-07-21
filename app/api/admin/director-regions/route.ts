import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { isVendorRegion } from "../../../lib/vendor-regions";

export async function GET(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const [directors, assignments] = await Promise.all([
      env.DB.prepare(`
        SELECT id,username,nickname,level,status
        FROM users
        WHERE is_director=1
        ORDER BY id DESC
      `).all(),
      env.DB.prepare("SELECT user_id AS userId,region,district FROM director_regions ORDER BY user_id,region,district").all(),
    ]);
    return Response.json({ directors: directors.results, assignments: assignments.results });
  } catch (error) {
    console.error("Director regions load failed", error);
    return Response.json({ error: "실장 담당지역을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const payload = await request.json() as { userId?: unknown; regions?: unknown };
    const userId = Number(payload.userId);
    if (!Number.isInteger(userId) || userId < 1 || !Array.isArray(payload.regions)) return Response.json({ error: "저장할 실장과 지역을 확인해 주세요." }, { status: 400 });
    const director = await env.DB.prepare("SELECT id,is_director AS isDirector FROM users WHERE id=? AND status='active'").bind(userId).first<{ id: number; isDirector: number }>();
    if (!director?.isDirector) return Response.json({ error: "현재 실장으로 지정된 회원만 지역을 배정할 수 있습니다." }, { status: 409 });
    const regions = payload.regions.map((entry) => {
      const item = entry as { region?: unknown; district?: unknown };
      return { region: typeof item.region === "string" ? item.region.trim() : "", district: typeof item.district === "string" ? item.district.trim() : "" };
    });
    if (regions.length > 250 || regions.some((item) => !isVendorRegion(item.region, item.district))) return Response.json({ error: "유효하지 않은 담당지역이 포함되어 있습니다." }, { status: 400 });
    const unique = [...new Map(regions.map((item) => [`${item.region}\u0000${item.district}`, item])).values()];
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM director_regions WHERE user_id=?").bind(userId),
      ...unique.map((item) => env.DB.prepare("INSERT INTO director_regions(user_id,region,district,created_at) VALUES(?,?,?,?)").bind(userId, item.region, item.district, now)),
    ]);
    return Response.json({ ok: true, assignments: unique });
  } catch (error) {
    console.error("Director regions update failed", error);
    return Response.json({ error: "실장 담당지역을 저장하지 못했습니다." }, { status: 500 });
  }
}

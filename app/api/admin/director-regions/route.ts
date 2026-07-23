import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { DEFAULT_ADMIN_PAGE_SIZE, isAdminPageSize } from "../../../lib/admin-pagination";
import { isVendorRegion } from "../../../lib/vendor-regions";

const privateJson = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "private, no-store" },
});

const positiveInteger = (value: string | null, fallback: number) => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function GET(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return privateJson({ error: "관리자 로그인이 필요합니다." }, 401);

  const url = new URL(request.url);
  const requestedUserId = url.searchParams.get("userId");
  if (requestedUserId !== null) {
    const userId = positiveInteger(requestedUserId, 0);
    if (userId === null || userId === 0) return privateJson({ error: "실장 정보를 확인해 주세요." }, 400);
    try {
      const director = await env.DB.prepare("SELECT id FROM users WHERE id=? AND is_director=1").bind(userId).first<{ id: number }>();
      if (!director) return privateJson({ error: "현재 실장으로 지정된 회원이 아닙니다." }, 404);
      const assignments = await env.DB.prepare(`
        SELECT user_id AS userId,region,district
        FROM director_regions
        WHERE user_id=?
        ORDER BY region,district
      `).bind(userId).all();
      return privateJson({ userId, assignments: assignments.results });
    } catch (error) {
      console.error("Director assignment load failed", error);
      return privateJson({ error: "실장 담당지역을 불러오지 못했습니다." }, 500);
    }
  }

  const requestedPage = positiveInteger(url.searchParams.get("page"), 1);
  const requestedPageSize = positiveInteger(url.searchParams.get("pageSize"), DEFAULT_ADMIN_PAGE_SIZE);
  if (requestedPage === null || requestedPageSize === null || !isAdminPageSize(requestedPageSize)) {
    return privateJson({ error: "실장 목록 조회 조건을 확인해 주세요." }, 400);
  }

  try {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE is_director=1").first<{ count: number }>();
    const total = Number(countRow?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * requestedPageSize;
    const directors = await env.DB.prepare(`
      SELECT u.id,u.username,u.nickname,u.level,u.status,
        (SELECT COUNT(*) FROM director_regions dr WHERE dr.user_id=u.id) AS assignmentCount
      FROM users u
      WHERE u.is_director=1
      ORDER BY u.created_at DESC,u.id DESC
      LIMIT ? OFFSET ?
    `).bind(requestedPageSize, offset).all();
    return privateJson({
      directors: directors.results,
      total,
      page,
      pageSize: requestedPageSize,
      totalPages,
    });
  } catch (error) {
    console.error("Director regions load failed", error);
    return privateJson({ error: "실장 담당지역을 불러오지 못했습니다." }, 500);
  }
}

export async function PUT(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return privateJson({ error: "관리자 로그인이 필요합니다." }, 401);

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return privateJson({ error: "저장할 실장과 지역을 확인해 주세요." }, 400);
  }
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return privateJson({ error: "저장할 실장과 지역을 확인해 주세요." }, 400);
  }
  const payload = rawPayload as { userId?: unknown; regions?: unknown };
  if (typeof payload.userId !== "number" || !Number.isInteger(payload.userId) || payload.userId < 1 || !Array.isArray(payload.regions)) {
    return privateJson({ error: "저장할 실장과 지역을 확인해 주세요." }, 400);
  }
  if (payload.regions.length > 250 || payload.regions.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    return privateJson({ error: "유효하지 않은 담당지역이 포함되어 있습니다." }, 400);
  }

  const userId = payload.userId;
  const regions = payload.regions.map((entry) => {
    const item = entry as { region?: unknown; district?: unknown };
    return { region: typeof item.region === "string" ? item.region.trim() : "", district: typeof item.district === "string" ? item.district.trim() : "" };
  });
  if (regions.some((item) => !isVendorRegion(item.region, item.district))) {
    return privateJson({ error: "유효하지 않은 담당지역이 포함되어 있습니다." }, 400);
  }

  try {
    const director = await env.DB.prepare("SELECT id,is_director AS isDirector FROM users WHERE id=? AND status='active'").bind(userId).first<{ id: number; isDirector: number }>();
    if (!director?.isDirector) return privateJson({ error: "현재 실장으로 지정된 회원만 지역을 배정할 수 있습니다." }, 409);
    const unique = [...new Map(regions.map((item) => [`${item.region}\u0000${item.district}`, item])).values()];
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("DELETE FROM director_regions WHERE user_id=?").bind(userId),
      ...unique.map((item) => env.DB.prepare(`
        INSERT INTO director_regions(user_id,region,district,created_at)
        SELECT ?,?,?,?
        WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND is_director=1 AND status='active')
      `).bind(userId, item.region, item.district, now, userId)),
    ]);
    if (unique.length && results.slice(1).some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      return privateJson({ error: "저장 중 실장 권한이 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해 주세요." }, 409);
    }
    return privateJson({ ok: true, assignments: unique });
  } catch (error) {
    console.error("Director regions update failed", error);
    return privateJson({ error: "실장 담당지역을 저장하지 못했습니다." }, 500);
  }
}

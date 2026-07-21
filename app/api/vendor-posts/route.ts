import { env } from "cloudflare:workers";
import { adminSession } from "../../lib/admin-auth";
import { memberFromSession, type MemberSession } from "../../lib/member-auth";
import { normalizeRichBody, normalizeRichTitle } from "../../lib/rich-text";
import {
  finalizeBodyMedia,
  mediaLifecycleErrorStatus,
  memberMediaActorKey,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../lib/media-lifecycle";
import { isVendorCategory, isVendorRegion, vendorRegionGroups, writableVendorCategories } from "../../lib/vendor-regions";
import { normalizeTitleColor } from "../../lib/title-colors";

const DAILY_VENDOR_JUMP_LIMIT = 30;
const VENDOR_JUMP_RESET_TEXT = "00시00분에 새롭게 갱신 됩니다";

type VendorPostRow = {
  id: number;
  industry: string;
  region: string;
  district: string;
  title: string;
  titleColor: string;
  body: string;
  authorId: number;
  author: string;
  authorLevel: number;
  createdAt: string;
  updatedAt: string;
};

const decorate = (post: VendorPostRow, viewer: MemberSession | null, adminActor = false) => {
  const canManage = adminActor || Boolean(viewer && (viewer.level === 10 || viewer.id === post.authorId));
  return {
    id: post.id, industry: post.industry, region: post.region, district: post.district, title: post.title, titleColor: post.titleColor, body: post.body,
    author: post.author, authorLevel: post.authorLevel, createdAt: post.createdAt, updatedAt: post.updatedAt,
    isOwn: Boolean(viewer && viewer.id === post.authorId), canEdit: canManage, canDelete: canManage,
  };
};

async function isActiveDirector(userId: number) {
  const row = await env.DB.prepare("SELECT is_director AS isDirector FROM users WHERE id=? AND status='active'").bind(userId).first<{ isDirector: number }>();
  return Boolean(row?.isDirector);
}

async function loadAssignments(userId: number) {
  const result = await env.DB.prepare(`
    SELECT dr.region,dr.district,
      CASE WHEN EXISTS(
        SELECT 1 FROM vendor_posts vp
        WHERE vp.author_id=dr.user_id AND vp.region=dr.region AND vp.district=dr.district AND vp.status='published'
      ) THEN 1 ELSE 0 END AS used
    FROM director_regions dr
    WHERE dr.user_id=?
    ORDER BY dr.region,dr.district
  `).bind(userId).all();
  return result.results;
}

function koreaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function loadJumpSummary(userId: number, assignmentCount: number) {
  if (!assignmentCount) return { remaining: 0, used: 0, limit: DAILY_VENDOR_JUMP_LIMIT, resetText: VENDOR_JUMP_RESET_TEXT };
  const row = await env.DB.prepare("SELECT used_count AS usedCount FROM vendor_post_jump_usage WHERE user_id=? AND jump_date=?")
    .bind(userId, koreaDateKey())
    .first<{ usedCount: number }>();
  const used = Math.max(0, Number(row?.usedCount ?? 0));
  return {
    remaining: Math.max(0, DAILY_VENDOR_JUMP_LIMIT - used),
    used,
    limit: DAILY_VENDOR_JUMP_LIMIT,
    resetText: VENDOR_JUMP_RESET_TEXT,
  };
}

function orderCase(column: string, values: readonly string[]) {
  return `CASE ${column} ${values.map((_, index) => `WHEN ? THEN ${index}`).join(" ")} ELSE ${values.length} END`;
}

const vendorRegionOrder = vendorRegionGroups.filter((group) => group.districts.length > 0).map((group) => group.label);
const vendorOrderValues = [...writableVendorCategories, ...vendorRegionOrder];
const vendorOrderSql = [
  "COALESCE(vp.jumped_at,vp.created_at) DESC",
  `${orderCase("vp.industry", writableVendorCategories)} ASC`,
  `${orderCase("vp.region", vendorRegionOrder)} ASC`,
  "vp.district ASC",
  "vp.id DESC",
].join(",");

export async function GET(request: Request) {
  try {
    const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
    const url = new URL(request.url);
    const industry = url.searchParams.get("industry")?.trim() || "전체";
    const region = url.searchParams.get("region")?.trim() || "전체";
    const district = url.searchParams.get("district")?.trim() || "전체";
    const search = url.searchParams.get("q")?.trim() || "";
    const cursorValue = url.searchParams.get("cursor");
    const cursor = cursorValue ? Number(cursorValue) : 0;
    if (industry !== "전체" && !isVendorCategory(industry)) return Response.json({ error: "업종을 확인해 주세요." }, { status: 400 });
    const regionExists = region === "전체" || vendorRegionGroups.some((group) => group.label === region);
    if (!regionExists || district !== "전체" && !isVendorRegion(region, district)) return Response.json({ error: "지역을 확인해 주세요." }, { status: 400 });
    if (search.length > 80) return Response.json({ error: "검색어는 80자 이내로 입력해 주세요." }, { status: 400 });
    if (cursorValue && (!Number.isInteger(cursor) || Number(cursor) < 1)) return Response.json({ error: "목록 위치를 확인해 주세요." }, { status: 400 });

    const conditions = ["vp.status='published'"];
    const bindings: Array<string | number> = [];
    if (industry !== "전체") { conditions.push("vp.industry=?"); bindings.push(industry); }
    if (region !== "전체") { conditions.push("vp.region=?"); bindings.push(region); }
    if (district !== "전체") { conditions.push("vp.district=?"); bindings.push(district); }
    if (search) {
      conditions.push(`(
        instr(lower(vp.industry),lower(?))>0 OR instr(lower(vp.region),lower(?))>0 OR
        instr(lower(vp.district),lower(?))>0 OR instr(lower(vp.title),lower(?))>0 OR
        instr(lower(vp.body),lower(?))>0
      )`);
      bindings.push(search, search, search, search, search);
    }
    const rows = await env.DB.prepare(`
      SELECT vp.id,vp.industry,vp.region,vp.district,vp.title,vp.title_color AS titleColor,vp.body,vp.author_id AS authorId,
             COALESCE(u.nickname,'탈퇴회원') AS author,COALESCE(u.level,0) AS authorLevel,
             vp.created_at AS createdAt,vp.updated_at AS updatedAt
      FROM vendor_posts vp LEFT JOIN users u ON u.id=vp.author_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${vendorOrderSql} LIMIT 31 OFFSET ?
    `).bind(...bindings, ...vendorOrderValues, cursor).all<VendorPostRow>();

    const canWrite = viewer ? await isActiveDirector(viewer.id) : false;
    const assignedRegions = viewer && canWrite ? await loadAssignments(viewer.id) : [];
    const jumpSummary = viewer && canWrite ? await loadJumpSummary(viewer.id, assignedRegions.length) : null;
    const page = rows.results.slice(0, 30);
    const nextCursor = rows.results.length > 30 ? cursor + page.length : null;
    return Response.json({ posts: page.map((post) => decorate(post, viewer, Boolean(operator))), nextCursor, canWrite, assignedRegions, jumpSummary });
  } catch (error) {
    console.error("Vendor post list load failed", error);
    return Response.json({ error: "업체정보 글을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const viewer = await memberFromSession(request);
  if (!viewer) return Response.json({ error: "로그인 후 글을 작성할 수 있습니다." }, { status: 401 });
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;
  let createdPostId = 0;
  try {
    const payload = await request.json() as { industry?: unknown; region?: unknown; district?: unknown; title?: unknown; titleColor?: unknown; body?: unknown };
    const industry = typeof payload.industry === "string" ? payload.industry.trim() : "";
    const region = typeof payload.region === "string" ? payload.region.trim() : "";
    const district = typeof payload.district === "string" ? payload.district.trim() : "";
    const { title, textLength: titleLength } = normalizeRichTitle(typeof payload.title === "string" ? payload.title : "");
    const titleColor = normalizeTitleColor(payload.titleColor);
    const sourceBody = typeof payload.body === "string" ? payload.body : "";
    if (!isVendorCategory(industry)) return Response.json({ error: "업종을 하나만 선택해 주세요." }, { status: 400 });
    if (!isVendorRegion(region, district)) return Response.json({ error: "상세지역을 하나만 선택해 주세요." }, { status: 400 });
    if (titleColor === null) return Response.json({ error: "제목 색상을 확인해 주세요." }, { status: 400 });
    const { body, textLength } = normalizeRichBody(sourceBody);
    const hasMedia = /<(?:img|video|iframe)\b/i.test(body);
    if (/post-poll-slot/i.test(body)) return Response.json({ error: "업체정보 글에는 투표를 넣을 수 없습니다." }, { status: 400 });
    if (titleLength < 2 || titleLength > 80) return Response.json({ error: "제목은 2~80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2~3,000자로 입력해 주세요." }, { status: 400 });
    mediaClaim = await reserveBodyMedia(env.DB, memberMediaActorKey(viewer.id), body);
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO vendor_posts(industry,region,district,title,title_color,body,author_id,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,u.id,'published',?,?
      FROM users u JOIN director_regions dr
        ON dr.user_id=u.id AND dr.region=? AND dr.district=?
      WHERE u.id=? AND u.status='active' AND u.is_director=1
    `).bind(industry, region, district, title, titleColor, body, now, now, region, district, viewer.id).run();
    if (!inserted.meta.changes) {
      await rollbackBodyMedia(env.DB, mediaClaim);
      mediaClaim = null;
      return Response.json({ error: "현재 실장 계정에 배정된 상세지역만 선택할 수 있습니다." }, { status: 403 });
    }
    createdPostId = Number(inserted.meta.last_row_id);
    await finalizeBodyMedia(env.DB, mediaClaim, "vendor", createdPostId, body, now);
    saveCommitted = true;
    const post: VendorPostRow = { id: createdPostId, industry, region, district, title, titleColor, body, authorId: viewer.id, author: viewer.nickname, authorLevel: viewer.level, createdAt: now, updatedAt: now };
    return Response.json({ post: decorate(post, viewer) }, { status: 201 });
  } catch (error) {
    if (!saveCommitted && createdPostId) {
      await env.DB.prepare("DELETE FROM vendor_posts WHERE id=?").bind(createdPostId).run().catch(() => undefined);
    }
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "해당 상세지역에는 이미 업체정보 글을 등록했습니다." }, { status: 409 });
    console.error("Vendor post creation failed", error);
    return Response.json({ error: "업체정보 글을 저장하지 못했습니다." }, { status: 500 });
  }
}

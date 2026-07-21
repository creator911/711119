import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../lib/member-auth";

const DAILY_VENDOR_JUMP_LIMIT = 30;
const VENDOR_JUMP_RESET_TEXT = "00시00분에 새롭게 갱신 됩니다";

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

export async function POST(request: Request) {
  const viewer = await memberFromSession(request);
  if (!viewer) return Response.json({ error: "로그인 후 상단점프를 사용할 수 있습니다." }, { status: 401 });

  try {
    const permission = await env.DB.prepare(`
      SELECT u.is_director AS isDirector,u.status,
             (SELECT COUNT(*) FROM director_regions dr WHERE dr.user_id=u.id) AS assignmentCount,
             (SELECT COUNT(*) FROM vendor_posts vp WHERE vp.author_id=u.id AND vp.status='published') AS postCount
      FROM users u WHERE u.id=?
    `).bind(viewer.id).first<{ isDirector: number; status: string; assignmentCount: number; postCount: number }>();

    if (!permission || permission.status !== "active" || !permission.isDirector) {
      return Response.json({ error: "실장 계정만 상단점프를 사용할 수 있습니다." }, { status: 403 });
    }
    if (!Number(permission.assignmentCount)) {
      return Response.json({ error: "담당 상세지역을 먼저 배정받아야 상단점프를 사용할 수 있습니다." }, { status: 403 });
    }
    if (!Number(permission.postCount)) {
      return Response.json({ error: "상단으로 올릴 업체정보 글이 없습니다." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const jumpDate = koreaDateKey();
    const current = await env.DB.prepare("SELECT used_count AS usedCount FROM vendor_post_jump_usage WHERE user_id=? AND jump_date=?")
      .bind(viewer.id, jumpDate)
      .first<{ usedCount: number }>();
    const used = Math.max(0, Number(current?.usedCount ?? 0));
    if (used >= DAILY_VENDOR_JUMP_LIMIT) {
      return Response.json({
        error: "오늘 사용할 수 있는 상단점프 횟수를 모두 사용했습니다.",
        jumpSummary: { remaining: 0, used, limit: DAILY_VENDOR_JUMP_LIMIT, resetText: VENDOR_JUMP_RESET_TEXT },
      }, { status: 429 });
    }

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO vendor_post_jump_usage(user_id,jump_date,used_count,updated_at)
        VALUES(?,?,0,?)
        ON CONFLICT(user_id,jump_date) DO NOTHING
      `).bind(viewer.id, jumpDate, now),
      env.DB.prepare(`
        UPDATE vendor_post_jump_usage
        SET used_count=used_count+1,updated_at=?
        WHERE user_id=? AND jump_date=? AND used_count<?
      `).bind(now, viewer.id, jumpDate, DAILY_VENDOR_JUMP_LIMIT),
      env.DB.prepare("UPDATE vendor_posts SET jumped_at=? WHERE author_id=? AND status='published'")
        .bind(now, viewer.id),
    ]);

    const nextUsed = used + 1;
    return Response.json({
      jumpSummary: {
        remaining: Math.max(0, DAILY_VENDOR_JUMP_LIMIT - nextUsed),
        used: nextUsed,
        limit: DAILY_VENDOR_JUMP_LIMIT,
        resetText: VENDOR_JUMP_RESET_TEXT,
      },
      jumpedAt: now,
    });
  } catch (error) {
    console.error("Vendor post jump failed", error);
    return Response.json({ error: "상단점프를 처리하지 못했습니다." }, { status: 500 });
  }
}

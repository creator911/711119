import { env } from "cloudflare:workers";
import { isAdminRequest } from "../../../lib/admin-auth";

const inquiryKindOf = (request: Request) => new URL(request.url).searchParams.get("kind") === "partner" ? "partner" : "support";

export async function GET(request: Request) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const kind = inquiryKindOf(request);
  try {
    const inquiries = await env.DB.prepare(`
      SELECT i.id,i.title,i.status,i.staff_unread AS staffUnread,i.member_unread AS memberUnread,
             i.created_at AS createdAt,i.updated_at AS updatedAt,
             u.id AS userId,u.username,u.nickname,u.points,
             (SELECT COUNT(*) FROM support_inquiry_replies r WHERE r.inquiry_id=i.id) AS replyCount
      FROM support_inquiries i JOIN users u ON u.id = i.user_id
      WHERE i.kind=? AND i.status != 'deleted'
      ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,i.staff_unread DESC,i.updated_at DESC
      LIMIT 300
    `).bind(kind).all();
    return Response.json({ inquiries: inquiries.results });
  } catch (error) {
    console.error("Admin support inquiries load failed", error);
    return Response.json({ error: "문의 목록을 불러오지 못했습니다." }, { status: 500 });
  }
}

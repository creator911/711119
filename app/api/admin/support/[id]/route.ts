import { env } from "cloudflare:workers";
import { adminSession, isAdminRequest } from "../../../../lib/admin-auth";

const inquiryIdOf = (context: { params: Promise<{ id: string }> }) => context.params.then(({ id }) => Number(id));
const inquiryKindOf = (request: Request) => new URL(request.url).searchParams.get("kind") === "partner" ? "partner" : "support";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const inquiryId = await inquiryIdOf(context);
  const kind = inquiryKindOf(request);
  if (!Number.isInteger(inquiryId) || inquiryId < 1) return Response.json({ error: "문의 번호를 확인해 주세요." }, { status: 400 });

  try {
    const inquiry = await env.DB.prepare(`
      SELECT i.id,i.title,i.body,i.status,i.staff_unread AS staffUnread,i.member_unread AS memberUnread,
             i.created_at AS createdAt,i.updated_at AS updatedAt,
             u.id AS userId,u.username,u.nickname,u.points
      FROM support_inquiries i JOIN users u ON u.id=i.user_id
      WHERE i.id=? AND i.kind=? AND i.status != 'deleted'
    `).bind(inquiryId, kind).first();
    if (!inquiry) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
    await env.DB.prepare("UPDATE support_inquiries SET staff_unread=0 WHERE id=?").bind(inquiryId).run();
    const replies = await env.DB.prepare(`
      SELECT id,sender_type AS senderType,body,created_at AS createdAt
      FROM support_inquiry_replies WHERE inquiry_id=? ORDER BY id ASC LIMIT 500
    `).bind(inquiryId).all();
    return Response.json({ inquiry: { ...inquiry, staffUnread: 0 }, replies: replies.results });
  } catch (error) {
    console.error("Admin support inquiry load failed", error);
    return Response.json({ error: "문의 내용을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const inquiryId = await inquiryIdOf(context);
  const kind = inquiryKindOf(request);
  const { body = "" } = await request.json() as { body?: string };
  const content = body.trim().replace(/\r\n/g, "\n");
  if (!Number.isInteger(inquiryId) || inquiryId < 1 || content.length < 1 || content.length > 1000) {
    return Response.json({ error: "답변 내용을 확인해 주세요." }, { status: 400 });
  }

  try {
    const inquiry = await env.DB.prepare("SELECT id FROM support_inquiries WHERE id=? AND kind=? AND status != 'deleted'").bind(inquiryId, kind).first();
    if (!inquiry) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO support_inquiry_replies(inquiry_id,sender_type,sender_id,body,created_at)
      VALUES(?,'staff',?,?,?)
    `).bind(inquiryId, operator.username, content, now).run();
    await env.DB.prepare(`
      UPDATE support_inquiries SET status='answered',member_unread=member_unread+1,updated_at=? WHERE id=?
    `).bind(now, inquiryId).run();
    return Response.json({ id: inserted.meta.last_row_id, senderType: "staff", body: content, createdAt: now }, { status: 201 });
  } catch (error) {
    console.error("Admin support inquiry reply failed", error);
    return Response.json({ error: "답변을 저장하지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const inquiryId = await inquiryIdOf(context);
  const kind = inquiryKindOf(request);
  const { status = "" } = await request.json() as { status?: string };
  if (!Number.isInteger(inquiryId) || inquiryId < 1 || !["open", "answered", "closed"].includes(status)) {
    return Response.json({ error: "문의 상태를 확인해 주세요." }, { status: 400 });
  }
  const result = await env.DB.prepare("UPDATE support_inquiries SET status=?,updated_at=? WHERE id=? AND kind=? AND status != 'deleted'").bind(status, new Date().toISOString(), inquiryId, kind).run();
  if (!result.meta.changes) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
  return Response.json({ ok: true, status });
}

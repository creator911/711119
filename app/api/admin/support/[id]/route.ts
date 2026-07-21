import { env } from "cloudflare:workers";
import { adminSession, isAdminRequest } from "../../../../lib/admin-auth";
import { adminMediaActorKey, mediaLifecycleErrorStatus, reserveBodyMedia, rollbackBodyMedia, supportReplyMediaFinalizeStatements, type MediaAttachmentClaim } from "../../../../lib/media-lifecycle";
import { normalizeRichBody, protectSupportMediaUrls } from "../../../../lib/rich-text";

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
    const safeInquiry = { ...inquiry, body: protectSupportMediaUrls(String((inquiry as { body?: unknown }).body ?? "")), staffUnread: 0 };
    const safeReplies = replies.results.map((reply) => ({ ...reply, body: protectSupportMediaUrls(String((reply as { body?: unknown }).body ?? "")) }));
    return Response.json({ inquiry: safeInquiry, replies: safeReplies });
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
  const payload = await request.json() as { body?: unknown };
  const source = typeof payload.body === "string" ? payload.body.replace(/\r\n/g, "\n") : "";
  const { body: content, textLength } = normalizeRichBody(source);
  const imageCount = (content.match(/<img\b/gi) ?? []).length;
  if (!Number.isInteger(inquiryId) || inquiryId < 1 || (textLength < 1 && imageCount < 1) || textLength > 1000 || content.length > 10000 || imageCount > 4 || /<(?:video|iframe)\b/i.test(content)) {
    return Response.json({ error: "답변 내용을 확인해 주세요." }, { status: 400 });
  }

  let mediaClaim: MediaAttachmentClaim | null = null;
  let insertedReplyId = 0;
  let saveCommitted = false;
  try {
    const inquiry = await env.DB.prepare("SELECT id FROM support_inquiries WHERE id=? AND kind=? AND status != 'deleted'").bind(inquiryId, kind).first();
    if (!inquiry) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
    mediaClaim = await reserveBodyMedia(env.DB, adminMediaActorKey(operator.role, operator.username), content);
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO support_inquiry_replies(inquiry_id,sender_type,sender_id,body,created_at)
      VALUES(?,'staff',?,?,?)
    `).bind(inquiryId, operator.username, content, now).run();
    insertedReplyId = Number(inserted.meta.last_row_id);
    await env.DB.batch([
      ...supportReplyMediaFinalizeStatements(env.DB, mediaClaim, inquiryId, insertedReplyId, content, now),
      env.DB.prepare("UPDATE support_inquiries SET status='answered',member_unread=member_unread+1,updated_at=? WHERE id=?").bind(now, inquiryId),
    ]);
    saveCommitted = true;
    return Response.json({ id: insertedReplyId, senderType: "staff", body: protectSupportMediaUrls(content), createdAt: now }, { status: 201 });
  } catch (error) {
    if (!saveCommitted && insertedReplyId) await env.DB.prepare("DELETE FROM support_inquiry_replies WHERE id=?").bind(insertedReplyId).run().catch(() => undefined);
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
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

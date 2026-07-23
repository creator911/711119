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
  const rawBeforeReplyId = new URL(request.url).searchParams.get("beforeReplyId");
  const beforeReplyId = rawBeforeReplyId === null ? null : Number(rawBeforeReplyId);
  if (!Number.isInteger(inquiryId) || inquiryId < 1 || (beforeReplyId !== null && (!Number.isSafeInteger(beforeReplyId) || beforeReplyId < 1))) return Response.json({ error: "문의 번호를 확인해 주세요." }, { status: 400 });

  try {
    const inquiry = await env.DB.prepare(`
      SELECT i.id,i.title,i.body,i.status,i.staff_unread AS staffUnread,i.member_unread AS memberUnread,
             i.created_at AS createdAt,i.updated_at AS updatedAt,
             u.id AS userId,u.username,u.nickname,u.points,
             COALESCE(s.reply_count,0) AS replyCount,
             COALESCE((SELECT MAX(r.id) FROM support_inquiry_replies r WHERE r.inquiry_id=i.id),0) AS latestReplyId
      FROM support_inquiries i
      JOIN users u ON u.id=i.user_id
      LEFT JOIN support_stats s ON s.inquiry_id=i.id
      WHERE i.id=? AND i.kind=? AND i.status != 'deleted'
    `).bind(inquiryId, kind).first();
    if (!inquiry) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
    const replies = await env.DB.prepare(`
      SELECT id,sender_type AS senderType,body,created_at AS createdAt
      FROM support_inquiry_replies
      WHERE inquiry_id=? ${beforeReplyId === null ? "" : "AND id<?"}
      ORDER BY id DESC LIMIT 501
    `).bind(...(beforeReplyId === null ? [inquiryId] : [inquiryId, beforeReplyId])).all();
    const replyRows = replies.results.slice(0, 500).reverse();
    const previousReplyCursor = replies.results.length > 500 ? Number((replyRows[0] as { id: number }).id) : null;
    const safeInquiry = { ...inquiry, body: protectSupportMediaUrls(String((inquiry as { body?: unknown }).body ?? "")) };
    const safeReplies = replyRows.map((reply) => ({ ...reply, body: protectSupportMediaUrls(String((reply as { body?: unknown }).body ?? "")) }));
    return Response.json({ inquiry: safeInquiry, replies: safeReplies, previousReplyCursor }, { headers: { "Cache-Control": "private, no-store" } });
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
  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return Response.json({ error: "답변 형식을 확인해 주세요." }, { status: 400 });
  }
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return Response.json({ error: "답변 형식을 확인해 주세요." }, { status: 400 });
  }
  const payload = rawPayload as { body?: unknown };
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
  const payload = await request.json().catch(() => null) as { status?: unknown; viewed?: unknown; viewedThroughReplyId?: unknown } | null;
  if (!Number.isInteger(inquiryId) || inquiryId < 1 || !payload) {
    return Response.json({ error: "문의 상태를 확인해 주세요." }, { status: 400 });
  }
  if (payload.viewed === true && payload.status === undefined) {
    const viewedThroughReplyId = Number(payload.viewedThroughReplyId);
    if (!Number.isSafeInteger(viewedThroughReplyId) || viewedThroughReplyId < 0) {
      return Response.json({ error: "문의 확인 요청을 확인해 주세요." }, { status: 400 });
    }
    const viewed = await env.DB.prepare(`
      UPDATE support_inquiries SET staff_unread=0
      WHERE id=? AND kind=? AND status != 'deleted'
        AND NOT EXISTS (SELECT 1 FROM support_inquiry_replies r WHERE r.inquiry_id=support_inquiries.id AND r.id>?)
    `).bind(inquiryId, kind, viewedThroughReplyId).run();
    if (!viewed.meta.changes) {
      const existing = await env.DB.prepare("SELECT id FROM support_inquiries WHERE id=? AND kind=? AND status != 'deleted'").bind(inquiryId, kind).first();
      if (!existing) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
      return Response.json({ ok: true, viewed: false }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return Response.json({ ok: true, viewed: true }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const status = typeof payload.status === "string" ? payload.status : "";
  if (payload.viewed !== undefined || !["open", "answered", "closed"].includes(status)) {
    return Response.json({ error: "문의 상태를 확인해 주세요." }, { status: 400 });
  }
  const result = await env.DB.prepare("UPDATE support_inquiries SET status=?,updated_at=? WHERE id=? AND kind=? AND status != 'deleted'").bind(status, new Date().toISOString(), inquiryId, kind).run();
  if (!result.meta.changes) return Response.json({ error: "문의글을 찾을 수 없습니다." }, { status: 404 });
  return Response.json({ ok: true, status });
}

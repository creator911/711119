import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { hasRichMedia, normalizeRichBody } from "../../lib/rich-text";
import {
  finalizeBodyMedia,
  mediaLifecycleErrorStatus,
  memberMediaActorKey,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../lib/media-lifecycle";

const inquiryKindOf = (request: Request) => new URL(request.url).searchParams.get("kind") === "partner" ? "partner" : "support";

export async function GET(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ inquiries: [], user: null });
  const kind = inquiryKindOf(request);

  try {
    const inquiries = await env.DB.prepare(`
      SELECT i.id,i.title,i.body,i.status,i.member_unread AS memberUnread,i.created_at AS createdAt,i.updated_at AS updatedAt,
             u.nickname AS author,
             (SELECT COUNT(*) FROM support_inquiry_replies r WHERE r.inquiry_id=i.id) AS replyCount
      FROM support_inquiries i JOIN users u ON u.id=i.user_id
      WHERE i.user_id=? AND i.kind=? AND i.status != 'deleted'
      ORDER BY i.id DESC LIMIT 100
    `).bind(user.id, kind).all();
    return Response.json({ user: { nickname: user.nickname }, inquiries: inquiries.results });
  } catch (error) {
    console.error("Support inquiries load failed", error);
    return Response.json({ error: "문의 목록을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const kind = inquiryKindOf(request);
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;
  let createdInquiryId = 0;

  try {
    const payload = await request.json() as { title?: unknown; body?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim().replace(/\s+/g, " ") : "";
    const bodyInput = typeof payload.body === "string" ? payload.body.replace(/\r\n/g, "\n") : "";
    const { body, textLength } = normalizeRichBody(bodyInput);
    const hasMedia = hasRichMedia(body);
    if (title.length < 2 || title.length > 80) return Response.json({ error: "제목은 2–80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2–3,000자로 입력해 주세요." }, { status: 400 });
    mediaClaim = await reserveBodyMedia(env.DB, memberMediaActorKey(user.id), body);
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO support_inquiries(user_id,kind,title,body,status,staff_unread,member_unread,created_at,updated_at)
      VALUES(?,?,?,?,'open',1,0,?,?)
    `).bind(user.id, kind, title, body, now, now).run();
    createdInquiryId = Number(inserted.meta.last_row_id);
    await finalizeBodyMedia(env.DB, mediaClaim, "support", createdInquiryId, body, now);
    saveCommitted = true;
    return Response.json({
      inquiry: { id: createdInquiryId, title, body, status: "open", memberUnread: 0, author: user.nickname, replyCount: 0, createdAt: now, updatedAt: now },
    }, { status: 201 });
  } catch (error) {
    if (!saveCommitted && createdInquiryId) {
      await env.DB.prepare("DELETE FROM support_inquiries WHERE id=?").bind(createdInquiryId).run().catch(() => undefined);
    }
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    console.error("Support inquiry creation failed", error);
    return Response.json({ error: "문의글을 저장하지 못했습니다." }, { status: 500 });
  }
}

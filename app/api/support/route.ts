import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { hasRichMedia, normalizeRichBody, protectSupportMediaUrls } from "../../lib/rich-text";
import {
  finalizeBodyMedia,
  mediaLifecycleErrorStatus,
  memberMediaActorKey,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../lib/media-lifecycle";
import { consumeSupportWriteLimit, supportRateLimitResponse } from "../../lib/support-rate-limit";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../lib/distributed-rate-limit";

const inquiryKindOf = (request: Request) => new URL(request.url).searchParams.get("kind") === "partner" ? "partner" : "support";
const SUPPORT_PAGE_SIZE = 20;

const positivePage = (value: string | null) => {
  if (value === null || value === "") return 1;
  if (!/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
};

export async function GET(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ inquiries: [], user: null, total: 0, page: 1, pageSize: SUPPORT_PAGE_SIZE, totalPages: 1 });
  const kind = inquiryKindOf(request);
  const requestedPage = positivePage(new URL(request.url).searchParams.get("page"));
  if (requestedPage === null) return Response.json({ error: "문의 목록 요청을 확인해 주세요." }, { status: 400 });

  try {
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM support_inquiries
      WHERE user_id=? AND kind=? AND status != 'deleted'
    `).bind(user.id, kind).first<{ count: number }>();
    const total = Math.max(0, Number(count?.count ?? 0));
    const totalPages = Math.max(1, Math.ceil(total / SUPPORT_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const inquiries = await env.DB.prepare(`
      SELECT i.id,i.title,i.status,i.member_unread AS memberUnread,i.created_at AS createdAt,i.updated_at AS updatedAt,
             u.nickname AS author,
             COALESCE(s.reply_count,0) AS replyCount
      FROM support_inquiries i
      JOIN users u ON u.id=i.user_id
      LEFT JOIN support_stats s ON s.inquiry_id=i.id
      WHERE i.user_id=? AND i.kind=? AND i.status != 'deleted'
      ORDER BY i.id DESC LIMIT ? OFFSET ?
    `).bind(user.id, kind, SUPPORT_PAGE_SIZE, (page - 1) * SUPPORT_PAGE_SIZE).all();
    return Response.json(
      { user: { nickname: user.nickname }, inquiries: inquiries.results, total, page, pageSize: SUPPORT_PAGE_SIZE, totalPages },
      { headers: { "Cache-Control": "private, no-store" } },
    );
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
    const distributedLimit = await consumeDistributedRateLimit(env.CACHE, `support-${kind}`, String(user.id), 60, 3_600);
    if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
    const payload = await request.json() as { title?: unknown; body?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim().replace(/\s+/g, " ") : "";
    const bodyInput = typeof payload.body === "string" ? payload.body.replace(/\r\n/g, "\n") : "";
    const { body, textLength } = normalizeRichBody(bodyInput);
    const hasMedia = hasRichMedia(body);
    if (title.length < 2 || title.length > 80) return Response.json({ error: "제목은 2–80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2–3,000자로 입력해 주세요." }, { status: 400 });
    const rateLimit = await consumeSupportWriteLimit(env.DB, user.id, "inquiry");
    if (!rateLimit.allowed) return supportRateLimitResponse(rateLimit);
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
      inquiry: { id: createdInquiryId, title, body: protectSupportMediaUrls(body), status: "open", memberUnread: 0, author: user.nickname, replyCount: 0, createdAt: now, updatedAt: now },
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

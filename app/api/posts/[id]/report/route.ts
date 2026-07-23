import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { autoDeletePostIfNeeded } from "../../../../lib/post-moderation";
import { isUniqueConstraintError } from "../../../../lib/database-errors";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../../lib/distributed-rate-limit";

const REPORT_REASONS = ["무단 홍보", "사기", "도배"] as const;

const parsePostId = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-2));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 신고할 수 있습니다." }, { status: 401 });
  const postId = parsePostId(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "post-report", String(user.id), 60, 60);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
  try {
    const payload = await request.json() as { reason?: unknown };
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    if (!REPORT_REASONS.includes(reason as typeof REPORT_REASONS[number])) return Response.json({ error: "신고 사유를 선택해 주세요." }, { status: 400 });
    const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND status='published'").bind(postId).first();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    const existing = await env.DB.prepare("SELECT id FROM post_reports WHERE post_id=? AND user_id=?").bind(postId, user.id).first();
    if (existing) return Response.json({ error: "이미 신고한 게시글입니다." }, { status: 409 });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO post_reports(post_id,user_id,reason,created_at) VALUES(?,?,?,?)")
        .bind(postId, user.id, reason, new Date().toISOString()),
      env.DB.prepare("UPDATE posts SET report_count=report_count+1 WHERE id=?").bind(postId),
    ]);
    const autoDeleted = await autoDeletePostIfNeeded(postId);
    const updated = await env.DB.prepare("SELECT likes,dislikes,report_count AS reportCount FROM posts WHERE id=?").bind(postId).first<{ likes: number; dislikes: number; reportCount: number }>();
    return Response.json({ likes: updated?.likes ?? 0, dislikes: updated?.dislikes ?? 0, reportCount: updated?.reportCount ?? 0, autoDeleted });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return Response.json({ error: "이미 신고한 게시글입니다." }, { status: 409 });
    }
    console.error("Post report failed", error);
    return Response.json({ error: "신고를 처리하지 못했습니다." }, { status: 500 });
  }
}

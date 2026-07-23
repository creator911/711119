import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { autoDeletePostIfNeeded } from "../../../../lib/post-moderation";
import { isUniqueConstraintError } from "../../../../lib/database-errors";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../../lib/distributed-rate-limit";

const parsePostId = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-2));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 추천할 수 있습니다." }, { status: 401 });
  const postId = parsePostId(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "post-vote", String(user.id), 120, 60);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);

  try {
    const payload = await request.json().catch(() => ({})) as { vote?: unknown };
    const vote = payload.vote === "down" ? "down" : payload.vote === "up" || payload.vote === undefined ? "up" : "";
    if (!vote) return Response.json({ error: "추천 종류를 확인해 주세요." }, { status: 400 });
    const post = await env.DB.prepare("SELECT id,author_id AS authorId FROM posts WHERE id=? AND status='published'").bind(postId).first<{ id: number; authorId: number }>();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    if (post.authorId === user.id) return Response.json({ error: "본인 게시글에는 추천이나 비추천을 할 수 없습니다." }, { status: 403 });
    const existing = await env.DB.prepare("SELECT id FROM post_recommendations WHERE post_id=? AND user_id=?").bind(postId, user.id).first();
    if (existing) return Response.json({ error: "이 게시글에는 이미 추천 또는 비추천을 했습니다." }, { status: 409 });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO post_recommendations(post_id,user_id,vote_type,created_at) VALUES(?,?,?,?)")
        .bind(postId, user.id, vote, new Date().toISOString()),
      env.DB.prepare(vote === "up" ? "UPDATE posts SET likes=likes+1 WHERE id=?" : "UPDATE posts SET dislikes=dislikes+1 WHERE id=?")
        .bind(postId),
    ]);
    const autoDeleted = await autoDeletePostIfNeeded(postId);
    const updated = await env.DB.prepare("SELECT likes,dislikes,report_count AS reportCount FROM posts WHERE id=?").bind(postId).first<{ likes: number; dislikes: number; reportCount: number }>();
    return Response.json({ likes: updated?.likes ?? 0, dislikes: updated?.dislikes ?? 0, reportCount: updated?.reportCount ?? 0, autoDeleted });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return Response.json({ error: "이 게시글에는 이미 추천 또는 비추천을 했습니다." }, { status: 409 });
    }
    console.error("Post recommendation failed", error);
    return Response.json({ error: "추천 또는 비추천을 처리하지 못했습니다." }, { status: 500 });
  }
}

import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { refreshAutomaticMemberLevel } from "../../../../lib/member-level-progress";
import { loadPointSettings } from "../../../../lib/point-settings";
import { maybePruneStalePreparedContent, publishCommentWithReward } from "../../../../lib/content-rewards";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../../lib/distributed-rate-limit";

const parsePostId = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-2));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function GET(request: Request) {
  const postId = parsePostId(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
  const requestedCursor = Number(url.searchParams.get("cursor") ?? 0);
  const cursor = Number.isInteger(requestedCursor) && requestedCursor > 0 ? requestedCursor : 0;
  try {
    const comments = await env.DB.prepare(`
      SELECT c.id,c.body,c.created_at AS createdAt,
             COALESCE(u.nickname,'탈퇴회원') AS author,
             COALESCE(u.level,0) AS authorLevel
      FROM post_comments c
      LEFT JOIN users u ON u.id=c.user_id
      WHERE c.post_id=? AND c.status='published' AND c.id>?
      ORDER BY c.id ASC
      LIMIT ${limit}
    `).bind(postId, cursor).all();
    const nextCursor = comments.results.length === limit
      ? Number((comments.results.at(-1) as { id?: unknown })?.id ?? 0) || null
      : null;
    return Response.json({ comments: comments.results, nextCursor }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Comment list load failed", error);
    return Response.json({ error: "댓글을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 댓글을 작성할 수 있습니다." }, { status: 401 });
  const postId = parsePostId(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "comment-create", String(user.id), 180, 60);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);

  let createdCommentId = 0;
  let saveCommitted = false;
  try {
    const payload = await request.json() as { body?: unknown };
    const body = typeof payload.body === "string" ? payload.body.trim().replace(/\r\n/g, "\n") : "";
    if (body.length < 1 || body.length > 500) return Response.json({ error: "댓글은 1–500자로 입력해 주세요." }, { status: 400 });
    const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND status='published'").bind(postId).first();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'pending',?)
    `).bind(postId, user.id, body, createdAt).run();
    const commentId = Number(inserted.meta.last_row_id);
    createdCommentId = commentId;
    await maybePruneStalePreparedContent(env.DB, commentId).catch((cleanupError) => {
      console.error("Stale prepared content cleanup failed", cleanupError);
    });
    const pointSettings = await loadPointSettings(env.DB);
    const reward = await publishCommentWithReward(env.DB, {
      commentId,
      postId,
      authorId: user.id,
      points: pointSettings.commentCreatePoints,
      createdAt,
    });
    saveCommitted = true;
    let authorLevel = user.level;
    try {
      authorLevel = await refreshAutomaticMemberLevel(env.DB, user.id);
    } catch (levelError) {
      console.error("Automatic member level refresh failed", levelError);
    }
    return Response.json({ comment: { id: commentId, body, author: user.nickname, authorLevel, createdAt }, earnedPoints: reward.earnedPoints }, { status: 201 });
  } catch (error) {
    if (createdCommentId && !saveCommitted) {
      await env.DB.prepare("DELETE FROM post_comments WHERE id=? AND status='pending'").bind(createdCommentId).run().catch(() => undefined);
    }
    console.error("Comment creation failed", error);
    return Response.json({ error: "댓글을 저장하지 못했습니다." }, { status: 500 });
  }
}

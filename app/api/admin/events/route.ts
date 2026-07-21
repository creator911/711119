import { env } from "cloudflare:workers";
import { isAdminRequest } from "../../../lib/admin-auth";
import { attachPostPoll, PollValidationError, preparePostBody } from "../../../lib/post-polls";
import { hasRichMedia } from "../../../lib/rich-text";
import {
  finalizeBodyMedia,
  mediaLifecycleErrorStatus,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../../lib/media-lifecycle";
import { mediaActorKey } from "../../../lib/media-actor";

export async function POST(request: Request) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;
  let createdPostId = 0;
  try {
    const payload = await request.json() as { title?: unknown; body?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim().replace(/\s+/g, " ") : "";
    const bodyInput = typeof payload.body === "string" ? payload.body.replace(/\r\n/g, "\n") : "";
    const { body, textLength, poll } = preparePostBody(bodyInput);
    const hasMedia = hasRichMedia(body);
    if (title.length < 2 || title.length > 80) return Response.json({ error: "제목은 2–80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia && !poll) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2–3,000자로 입력해 주세요." }, { status: 400 });
    const actorKey = await mediaActorKey(request, env);
    if (!actorKey) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
    mediaClaim = await reserveBodyMedia(env.DB, actorKey, body);
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO posts(category,title,body,author_id,views,likes,status,created_at)
      VALUES('events',?,?,0,0,0,'published',?)
    `).bind(title, body, createdAt).run();
    const postId = Number(inserted.meta.last_row_id);
    createdPostId = postId;
    const finalBody = await attachPostPoll(env.DB, postId, body, poll, createdAt);
    await finalizeBodyMedia(env.DB, mediaClaim, "post", postId, finalBody, createdAt);
    saveCommitted = true;
    return Response.json({
      post: { id: postId, category: "events", title, body: finalBody, author: "운영자", authorLevel: 0, views: 0, likes: 0, status: "published", createdAt },
    }, { status: 201 });
  } catch (error) {
    if (!saveCommitted && createdPostId) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM post_poll_votes WHERE poll_id IN (SELECT id FROM post_polls WHERE post_id=?)").bind(createdPostId),
        env.DB.prepare("DELETE FROM post_poll_options WHERE poll_id IN (SELECT id FROM post_polls WHERE post_id=?)").bind(createdPostId),
        env.DB.prepare("DELETE FROM post_polls WHERE post_id=?").bind(createdPostId),
        env.DB.prepare("DELETE FROM posts WHERE id=?").bind(createdPostId),
      ]).catch(() => undefined);
    }
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    if (error instanceof PollValidationError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Admin event creation failed", error);
    return Response.json({ error: "이벤트 등록 중 오류가 발생했습니다." }, { status: 500 });
  }
}

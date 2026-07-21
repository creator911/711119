import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { attachPostPoll, PollValidationError, preparePostBody } from "../../lib/post-polls";
import { buildPostListQuery } from "../../lib/post-list-query";
import { hasRichMedia } from "../../lib/rich-text";
import {
  finalizeBodyMedia,
  mediaLifecycleErrorStatus,
  memberMediaActorKey,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../lib/media-lifecycle";

const BOARD_CATEGORIES = ["notices", "reviews", "events", "gifs", "community"] as const;
const MEMBER_WRITE_CATEGORIES = ["reviews", "gifs", "community"] as const;

const validCategory = (value: string): value is typeof BOARD_CATEGORIES[number] =>
  BOARD_CATEGORIES.includes(value as typeof BOARD_CATEGORIES[number]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? "";
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "latest";
  if (!validCategory(category)) return Response.json({ error: "게시판 종류를 확인해 주세요." }, { status: 400 });
  try {
    const { sql, bindings } = buildPostListQuery(category, sort);
    const statement = env.DB.prepare(sql);
    const posts = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return Response.json({ posts: posts.results });
  } catch (error) {
    console.error("Post list load failed", error);
    return Response.json({ error: "게시글을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 글을 작성할 수 있습니다." }, { status: 401 });
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;
  let createdPostId = 0;
  try {
    const payload = await request.json() as { category?: unknown; title?: unknown; body?: unknown; isPinned?: unknown };
    const category = typeof payload.category === "string" ? payload.category : "";
    const title = typeof payload.title === "string" ? payload.title : "";
    const body = typeof payload.body === "string" ? payload.body : "";
    const isPinned = payload.isPinned === true;
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    const { body: normalizedBody, textLength, poll } = preparePostBody(body);
    const hasMedia = hasRichMedia(normalizedBody);
    if (!MEMBER_WRITE_CATEGORIES.includes(category as typeof MEMBER_WRITE_CATEGORIES[number])) {
      return Response.json({ error: "이 게시판에는 회원 글을 등록할 수 없습니다." }, { status: 403 });
    }
    if (isPinned && (user.level !== 10 || (category !== "community" && category !== "reviews"))) {
      return Response.json({ error: "커뮤니티·후기 상단 고정은 레벨 10 관리자만 사용할 수 있습니다." }, { status: 403 });
    }
    if (normalizedTitle.length < 2 || normalizedTitle.length > 80) return Response.json({ error: "제목은 2–80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia && !poll) || textLength > 3000 || normalizedBody.length > 20000) return Response.json({ error: "내용은 2–3,000자로 입력해 주세요." }, { status: 400 });
    mediaClaim = await reserveBodyMedia(env.DB, memberMediaActorKey(user.id), normalizedBody);
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO posts(category,title,body,author_id,views,likes,dislikes,report_count,is_notice,is_pinned,status,created_at)
      VALUES(?,?,?,?,0,0,0,0,0,?,'published',?)
    `).bind(category, normalizedTitle, normalizedBody, user.id, isPinned ? 1 : 0, createdAt).run();
    const postId = Number(inserted.meta.last_row_id);
    createdPostId = postId;
    const finalBody = await attachPostPoll(env.DB, postId, normalizedBody, poll, createdAt);
    await finalizeBodyMedia(env.DB, mediaClaim, "post", postId, finalBody, createdAt);
    saveCommitted = true;
    return Response.json({
      post: { id: postId, category, title: normalizedTitle, body: finalBody, author: user.nickname, authorLevel: user.level, views: 0, likes: 0, dislikes: 0, reportCount: 0, commentCount: 0, isNotice: false, isPinned, isOwn: true, canEdit: true, canDelete: true, createdAt },
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
    console.error("Post creation failed", error);
    return Response.json({ error: "게시글 저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}

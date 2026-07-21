import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { attachPostPoll, PollValidationError, preparePostBody } from "../../lib/post-polls";
import { buildPostListQuery } from "../../lib/post-list-query";
import { communityTagsFromMask, isCommunityBoardCategory, validateCommunityTags, type CommunityTag } from "../../lib/community-tags";
import { normalizeTitleColor } from "../../lib/title-colors";
import { hasRichMedia } from "../../lib/rich-text";
import { refreshAutomaticMemberLevel } from "../../lib/member-level-progress";
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

const exposeCommunityTags = (row: Record<string, unknown>) => {
  const { communityTagMask, ...post } = row;
  return { ...post, communityTags: communityTagsFromMask(communityTagMask, row.category) };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? "";
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "latest";
  if (!validCategory(category)) return Response.json({ error: "게시판 종류를 확인해 주세요." }, { status: 400 });
  try {
    const { sql, bindings } = buildPostListQuery(category, sort);
    const statement = env.DB.prepare(sql);
    const posts = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return Response.json({ posts: posts.results.map((post) => exposeCommunityTags(post as Record<string, unknown>)) });
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
    const payload = await request.json() as { category?: unknown; title?: unknown; titleColor?: unknown; body?: unknown; isPinned?: unknown; communityTags?: unknown };
    const category = typeof payload.category === "string" ? payload.category : "";
    const title = typeof payload.title === "string" ? payload.title : "";
    const titleColor = normalizeTitleColor(payload.titleColor);
    const body = typeof payload.body === "string" ? payload.body : "";
    const isPinned = payload.isPinned === true;
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    const { body: normalizedBody, textLength, poll } = preparePostBody(body);
    const hasMedia = hasRichMedia(normalizedBody);
    let communityTags: CommunityTag[] = [];
    let communityTagMask = 0;
    if (!MEMBER_WRITE_CATEGORIES.includes(category as typeof MEMBER_WRITE_CATEGORIES[number])) {
      return Response.json({ error: "이 게시판에는 회원 글을 등록할 수 없습니다." }, { status: 403 });
    }
    if (titleColor === null) return Response.json({ error: "제목 색상을 확인해 주세요." }, { status: 400 });
    if (isPinned && (user.level !== 10 || (category !== "community" && category !== "reviews"))) {
      return Response.json({ error: "커뮤니티·후기 상단 고정은 레벨 10 관리자만 사용할 수 있습니다." }, { status: 403 });
    }
    if (isCommunityBoardCategory(category)) {
      const validated = validateCommunityTags(payload.communityTags);
      if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
      communityTags = validated.tags;
      communityTagMask = validated.mask;
    } else if (payload.communityTags !== undefined && (!Array.isArray(payload.communityTags) || payload.communityTags.length > 0)) {
      return Response.json({ error: "머릿글은 커뮤니티 글에만 사용할 수 있습니다." }, { status: 400 });
    }
    if (normalizedTitle.length < 2 || normalizedTitle.length > 80) return Response.json({ error: "제목은 2–80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia && !poll) || textLength > 3000 || normalizedBody.length > 20000) return Response.json({ error: "내용은 2–3,000자로 입력해 주세요." }, { status: 400 });
    mediaClaim = await reserveBodyMedia(env.DB, memberMediaActorKey(user.id), normalizedBody);
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO posts(category,title,title_color,body,author_id,views,likes,dislikes,report_count,is_notice,is_pinned,community_tag_mask,status,created_at)
      VALUES(?,?,?,?,?,0,0,0,0,0,?,?,'published',?)
    `).bind(category, normalizedTitle, titleColor, normalizedBody, user.id, isPinned ? 1 : 0, communityTagMask, createdAt).run();
    const postId = Number(inserted.meta.last_row_id);
    createdPostId = postId;
    const finalBody = await attachPostPoll(env.DB, postId, normalizedBody, poll, createdAt);
    await finalizeBodyMedia(env.DB, mediaClaim, "post", postId, finalBody, createdAt);
    saveCommitted = true;
    let authorLevel = user.level;
    try {
      authorLevel = await refreshAutomaticMemberLevel(env.DB, user.id);
    } catch (levelError) {
      console.error("Automatic member level refresh failed", levelError);
    }
    return Response.json({
      post: { id: postId, category, title: normalizedTitle, titleColor, body: finalBody, communityTags, author: user.nickname, authorLevel, views: 0, likes: 0, dislikes: 0, reportCount: 0, commentCount: 0, isNotice: false, isPinned, isOwn: true, canEdit: true, canDelete: true, createdAt },
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
